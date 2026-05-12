import type { DbType } from "./store";
import mysql from "mysql2/promise";
import pg from "pg";
import mssql from "mssql";

export type TestResult =
  | { ok: true; dbType: Exclude<DbType, "auto"> }
  | { ok: false; message: string; internalReason?: string };

const CONNECT_TIMEOUT_MS = 5000;
const MAX_CONCURRENT = Math.max(
  1,
  Number(process.env.DB_MAX_CONCURRENT_CONNECTS ?? "5")
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

// --------------------------- semaphore -----------------------------
let active = 0;
let shuttingDown = false;
const waiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

async function acquireSlot(): Promise<void> {
  if (shuttingDown) throw new Error("Server shutting down");
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }));
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) next.resolve();
  else active--;
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
function mysqlSslOption(useSsl: boolean | undefined): mysql.ConnectionOptions["ssl"] {
  if (!useSsl) return undefined;
  return { rejectUnauthorized: SSL_STRICT };
}

function pgSslOption(useSsl: boolean | undefined): pg.ClientConfig["ssl"] {
  if (!useSsl) return false;
  return { rejectUnauthorized: SSL_STRICT };
}

// --------------------------- entry ---------------------------------
export type TestConnectionInput = {
  dbType: DbType;
  host: string;
  port: number;
  user?: string;
  password: string;
  ssl?: boolean;
  mssqlTrustServerCertificate?: boolean;
};

export async function testConnection(input: TestConnectionInput): Promise<TestResult> {
  await acquireSlot();
  try {
    return await runTest(input);
  } finally {
    releaseSlot();
  }
}

// --------------------------- core ----------------------------------
async function runTest(input: TestConnectionInput): Promise<TestResult> {
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
        await tryWithRetry(() => connectMysql(input));
        return { ok: true, dbType: "mysql" };
      }
      if (t === "postgresql") {
        await tryWithRetry(() => connectPg(input));
        return { ok: true, dbType: "postgresql" };
      }
      if (t === "mssql") {
        await tryWithRetry(() => connectMssql(input));
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

async function connectMysql(input: TestConnectionInput): Promise<void> {
  const conn = await safelyConnect(
    () => mysql.createConnection({
      host: input.host,
      port: input.port,
      user: input.user ?? "root",
      password: input.password,
      connectTimeout: CONNECT_TIMEOUT_MS,
      ssl: mysqlSslOption(input.ssl)
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

async function connectPg(input: TestConnectionInput): Promise<void> {
  const client = await safelyConnect(
    async () => {
      const c = new pg.Client({
        host: input.host,
        port: input.port,
        user: input.user ?? "postgres",
        password: input.password,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
        statement_timeout: CONNECT_TIMEOUT_MS,
        ssl: pgSslOption(input.ssl)
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

async function connectMssql(input: TestConnectionInput): Promise<void> {
  const pool = await safelyConnect(
    () => new mssql.ConnectionPool({
      server: input.host,
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
