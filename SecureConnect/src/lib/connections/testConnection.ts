import type { DbType } from "./store";
import mysql from "mysql2/promise";
import pg from "pg";
import mssql from "mssql";
import { ensureSafeHost } from "@/lib/security/ssrfGuard";

export type TestResult =
  | { ok: true; dbType: Exclude<DbType, "auto"> }
  | { ok: false; message: string; internalReason?: string };

const CONNECT_TIMEOUT_MS = 5000;
const MAX_GLOBAL = Math.max(
  1,
  Number(process.env.DB_MAX_CONCURRENT_CONNECTS ?? "10")
);
const MAX_PER_USER = Math.max(
  1,
  Number(process.env.DB_MAX_PER_USER_CONNECTS ?? "2")
);
const SSL_STRICT = process.env.DB_SSL_STRICT === "true";
const RETRY_BACKOFF_MS = 200;
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "ENETDOWN"
]);

// NOTE: connections are intentionally NOT pooled across /api/connect calls.
// Pooling would retain decrypted credentials in memory beyond the request lifetime,
// which contradicts the "no secret persistence" goal. test-then-close is by design.

// --------------------------- semaphore (per-user + global) ----------
let active = 0;
let shuttingDown = false;
const perUser = new Map<string, number>();
const waiters: Array<{ key: string; resolve: () => void; reject: (err: Error) => void }> = [];

function canAcquire(email: string): boolean {
  return active < MAX_GLOBAL && (perUser.get(email) ?? 0) < MAX_PER_USER;
}
function incrementSlot(email: string): void {
  active++;
  perUser.set(email, (perUser.get(email) ?? 0) + 1);
}
function decrementSlot(email: string): void {
  active = Math.max(0, active - 1);
  const cur = perUser.get(email) ?? 0;
  if (cur <= 1) perUser.delete(email);
  else perUser.set(email, cur - 1);
}

async function acquireSlot(email: string): Promise<void> {
  if (shuttingDown) throw new Error("Server shutting down");
  if (canAcquire(email)) {
    incrementSlot(email);
    return;
  }
  await new Promise<void>((resolve, reject) => waiters.push({ key: email, resolve, reject }));
}

function releaseSlot(email: string): void {
  decrementSlot(email);
  // Wake the first waiter that fits BOTH global + per-user limits.
  for (let i = 0; i < waiters.length; i++) {
    const w = waiters[i];
    if (canAcquire(w.key)) {
      waiters.splice(i, 1);
      incrementSlot(w.key);
      w.resolve();
      return;
    }
  }
}

// --------------------------- helpers -------------------------------
function isTransientError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: string }).code;
  if (code && TRANSIENT_CODES.has(code)) return true;
  const msg = e.message.toUpperCase();
  for (const c of TRANSIENT_CODES) {
    if (msg.includes(c)) return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function tryWithRetry<T>(op: () => Promise<T>, retries = 1): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await op();
    } catch (e) {
      lastErr = e;
      if (i < retries && isTransientError(e)) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function safelyConnect<T>(
  factory: () => Promise<T>,
  destroy: (conn: T) => Promise<unknown> | unknown,
  timeoutMs: number,
  label: string
): Promise<T> {
  let aborted = false;
  const wrapped = factory().then((c) => {
    if (aborted) {
      Promise.resolve(destroy(c)).catch(() => undefined);
      throw new Error(`${label}: connection arrived after timeout`);
    }
    return c;
  });
  try {
    return await withTimeout(wrapped, timeoutMs, label);
  } catch (e) {
    aborted = true;
    throw e;
  }
}

async function safeClose(label: string, op: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await op();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[${label}] close failed:`, e instanceof Error ? e.message : String(e));
  }
}

function guessDbTypeByPort(port: number): Exclude<DbType, "auto"> | null {
  if (port === 3306) return "mysql";
  if (port === 5432) return "postgresql";
  if (port === 1433) return "mssql";
  return null;
}

// --------------------------- SSL config ----------------------------
// `servername` ensures the SNI / TLS hostname check uses the user-supplied
// hostname, even though we connect to a pre-resolved IP (DNS-rebind defense).
function mysqlSslOption(useSsl: boolean | undefined, serverName: string): mysql.ConnectionOptions["ssl"] {
  if (!useSsl) return undefined;
  return { rejectUnauthorized: SSL_STRICT, servername: serverName } as unknown as mysql.ConnectionOptions["ssl"];
}

function pgSslOption(useSsl: boolean | undefined, serverName: string): pg.ClientConfig["ssl"] {
  if (!useSsl) return false;
  return { rejectUnauthorized: SSL_STRICT, servername: serverName };
}

// --------------------------- entry ---------------------------------
export type TestConnectionInput = {
  ownerEmail: string;
  dbType: DbType;
  host: string;
  port: number;
  user?: string;
  password: string;
  ssl?: boolean;
  mssqlTrustServerCertificate?: boolean;
  // Pre-resolved IP from ssrfGuard. When provided, drivers connect to this IP
  // instead of re-resolving the hostname (defense against DNS rebinding).
  resolvedIp?: string;
};

export async function testConnection(input: TestConnectionInput): Promise<TestResult> {
  await acquireSlot(input.ownerEmail);
  try {
    return await runTest(input);
  } finally {
    releaseSlot(input.ownerEmail);
  }
}

// --------------------------- core ----------------------------------
async function runTest(input: TestConnectionInput): Promise<TestResult> {
  // Resolve + SSRF-check here if caller hasn't pre-resolved. This guarantees
  // the driver connects to the SAME IP we vetted (DNS rebinding defense).
  let connectHost = input.resolvedIp;
  if (!connectHost) {
    const allowPrivate = process.env.ALLOW_PRIVATE_HOSTS === "true";
    const safe = await ensureSafeHost(input.host, { allowPrivate });
    if (!safe.ok) {
      return { ok: false, message: "Host not allowed", internalReason: safe.reason };
    }
    connectHost = safe.ip;
  }

  const candidates: Exclude<DbType, "auto">[] = [];
  if (input.dbType !== "auto") {
    candidates.push(input.dbType);
  } else {
    const g = guessDbTypeByPort(input.port);
    if (g) candidates.push(g);
    for (const t of ["mysql", "postgresql", "mssql"] as const) {
      if (!candidates.includes(t)) candidates.push(t);
    }
  }

  const errors: string[] = [];
  for (const t of candidates) {
    try {
      if (t === "mysql") {
        await tryWithRetry(() => connectMysql(input, connectHost!));
        return { ok: true, dbType: "mysql" };
      }
      if (t === "postgresql") {
        await tryWithRetry(() => connectPg(input, connectHost!));
        return { ok: true, dbType: "postgresql" };
      }
      if (t === "mssql") {
        await tryWithRetry(() => connectMssql(input, connectHost!));
        return { ok: true, dbType: "mssql" };
      }
    } catch (e) {
      errors.push(`[${t}] ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    ok: false,
    message: "Unable to connect to database",
    internalReason: errors.join(" | ")
  };
}

async function connectMysql(input: TestConnectionInput, connectHost: string): Promise<void> {
  const conn = await safelyConnect(
    () => mysql.createConnection({
      host: connectHost,
      port: input.port,
      user: input.user ?? "root",
      password: input.password,
      connectTimeout: CONNECT_TIMEOUT_MS,
      ssl: mysqlSslOption(input.ssl, input.host)
    }),
    (c) => c.end(),
    CONNECT_TIMEOUT_MS + 500,
    "mysql connect"
  );
  try {
    await withTimeout(conn.ping(), CONNECT_TIMEOUT_MS, "mysql ping");
  } finally {
    await safeClose("mysql", () => conn.end());
  }
}

async function connectPg(input: TestConnectionInput, connectHost: string): Promise<void> {
  const client = await safelyConnect(
    async () => {
      const c = new pg.Client({
        host: connectHost,
        port: input.port,
        user: input.user ?? "postgres",
        password: input.password,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
        statement_timeout: CONNECT_TIMEOUT_MS,
        ssl: pgSslOption(input.ssl, input.host)
      });
      await c.connect();
      return c;
    },
    (c) => c.end(),
    CONNECT_TIMEOUT_MS + 500,
    "pg connect"
  );
  try {
    await withTimeout(client.query("SELECT 1"), CONNECT_TIMEOUT_MS, "pg query");
  } finally {
    await safeClose("pg", () => client.end());
  }
}

async function connectMssql(input: TestConnectionInput, connectHost: string): Promise<void> {
  const pool = await safelyConnect(
    () => new mssql.ConnectionPool({
      server: connectHost,
      port: input.port,
      user: input.user ?? "sa",
      password: input.password,
      connectionTimeout: CONNECT_TIMEOUT_MS,
      requestTimeout: CONNECT_TIMEOUT_MS,
      options: {
        encrypt: input.ssl !== false,
        trustServerCertificate: input.mssqlTrustServerCertificate === true
      }
    }).connect(),
    (p) => p.close(),
    CONNECT_TIMEOUT_MS + 500,
    "mssql connect"
  );
  try {
    await withTimeout(
      pool.request().query("SELECT 1 AS ok"),
      CONNECT_TIMEOUT_MS,
      "mssql query"
    );
  } finally {
    await safeClose("mssql", () => pool.close());
  }
}

// --------------------------- shutdown ------------------------------
function shutdown(): void {
  shuttingDown = true;
  while (waiters.length > 0) {
    const w = waiters.shift();
    if (w) w.reject(new Error("Server shutting down"));
  }
}
if (typeof process !== "undefined" && typeof process.once === "function") {
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
