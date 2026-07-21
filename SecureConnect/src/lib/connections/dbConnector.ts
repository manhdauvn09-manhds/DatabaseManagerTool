/**
 * Open a fresh DB connection from a ConnectionRecord, run queries via a uniform
 * `q(sql, params)` interface, then close. NEVER pool / NEVER keep credentials longer
 * than the request lifetime.
 */
import mysql from "mysql2/promise";
import pg from "pg";
import mssql from "mssql";
import type { ConnectionRecord } from "./store";

export type DriverType = "mysql" | "postgresql" | "mssql";

export type QueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  // INSERT/UPDATE/DELETE only — number of rows affected. SELECT: same as rowCount.
  affectedRows?: number;
  // INSERT only (mysql AUTO_INCREMENT). undefined for pg/mssql (use RETURNING / OUTPUT instead).
  insertId?: number | string;
};

export type QueryFn = (sql: string, params?: unknown[]) => Promise<QueryResult>;

const CONNECT_TIMEOUT_MS = 5000;
const QUERY_TIMEOUT_MS = 15000;
const SSL_STRICT = process.env.DB_SSL_STRICT === "true";
// S-2 fix: MySQL defaults to opportunistic TLS. Set DB_SSL_DISABLED=true only for servers that cannot do TLS.
const SSL_DISABLED = process.env.DB_SSL_DISABLED === "true";

// ---------- identifier safety ----------

const IDENT_REGEX = /^[a-zA-Z0-9_]{1,64}$/;

export function validateIdent(name: string, label = "identifier"): void {
  if (typeof name !== "string" || !IDENT_REGEX.test(name)) {
    throw new Error(`Invalid ${label}: ${name}`);
  }
}

export function quoteIdent(name: string, driver: DriverType): string {
  validateIdent(name);
  if (driver === "mysql") return `\`${name}\``;
  if (driver === "postgresql") return `"${name}"`;
  return `[${name}]`; // mssql
}

export function qualified(parts: string[], driver: DriverType): string {
  return parts.map((p) => quoteIdent(p, driver)).join(".");
}

// ---------- timeout ----------

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

// ---------- core ----------

// A live driver handle: a uniform query function + a close fn.
type Handle = { q: QueryFn; close: () => Promise<void> };

const POOL_ENABLED = process.env.DB_POOL_ENABLED === "true";
const POOL_IDLE_MS = Math.max(5_000, Number(process.env.DB_POOL_IDLE_MS ?? "30000"));

export async function withConnection<T>(
  rec: ConnectionRecord,
  fn: (q: QueryFn, ctx: { driver: DriverType }) => Promise<T>
): Promise<T> {
  const driver = rec.dbType as DriverType;
  if (!POOL_ENABLED) {
    // Default (proven) path: open a fresh connection per call, always close.
    const h = await connect(rec, driver);
    try {
      return await fn(h.q, { driver });
    } finally {
      await h.close().catch(() => undefined);
    }
  }
  return runPooled(rec, driver, fn);
}

async function connect(rec: ConnectionRecord, driver: DriverType): Promise<Handle> {
  if (driver === "mysql") return connectMysql(rec);
  if (driver === "postgresql") return connectPg(rec);
  if (driver === "mssql") return connectMssql(rec);
  throw new Error(`Unsupported driver: ${driver}`);
}

async function connectMysql(rec: ConnectionRecord): Promise<Handle> {
  // DNS-rebind defense: prefer the IP we already vetted on /api/connect.
  const connectHost = rec.resolvedIp ?? rec.host;
  const conn = await withTimeout(
    mysql.createConnection({
      host: connectHost,
      port: rec.port,
      user: rec.user ?? "root",
      password: rec.password,
      connectTimeout: CONNECT_TIMEOUT_MS,
      multipleStatements: false,
      dateStrings: true,
      ssl: SSL_DISABLED ? undefined : (SSL_STRICT ? { rejectUnauthorized: true } : { rejectUnauthorized: false })
    }),
    CONNECT_TIMEOUT_MS + 500,
    "mysql connect"
  );
  const q: QueryFn = async (sql, params) => {
    const result = await withTimeout(
      conn.query(sql, params ?? []) as Promise<[mysql.RowDataPacket[] | mysql.ResultSetHeader, mysql.FieldPacket[] | undefined]>,
      QUERY_TIMEOUT_MS,
      "mysql query"
    );
    const data = result[0];
    const fields = result[1];
    if (Array.isArray(data)) {
      const cols = fields ? fields.map((f) => f.name) : [];
      const rows = data as Record<string, unknown>[];
      return { columns: cols, rows, rowCount: rows.length };
    }
    const rsh = data as mysql.ResultSetHeader;
    return {
      columns: [],
      rows: [],
      rowCount: rsh.affectedRows ?? 0,
      affectedRows: rsh.affectedRows,
      insertId: rsh.insertId !== undefined && rsh.insertId !== 0 ? rsh.insertId : undefined
    };
  };
  return { q, close: async () => { await conn.end().catch(() => undefined); } };
}

async function connectPg(rec: ConnectionRecord): Promise<Handle> {
  const connectHost = rec.resolvedIp ?? rec.host;
  const client = new pg.Client({
    host: connectHost,
    port: rec.port,
    user: rec.user ?? "postgres",
    password: rec.password,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
    ssl: SSL_STRICT ? { rejectUnauthorized: true, servername: rec.host } : undefined
  });
  await withTimeout(client.connect(), CONNECT_TIMEOUT_MS + 500, "pg connect");
  const q: QueryFn = async (sql, params) => {
    // Translate ?-placeholders to $N so callers can use ? uniformly across drivers.
    let bound = sql;
    if (params && params.length > 0 && bound.includes("?")) {
      let i = 0;
      bound = bound.replace(/\?/g, () => `$${++i}`);
    }
    const result = await withTimeout(client.query(bound, params), QUERY_TIMEOUT_MS, "pg query");
    const cols = result.fields?.map((f) => f.name) ?? [];
    const out = (result.rows ?? []) as Record<string, unknown>[];
    const affected = result.rowCount ?? out.length;
    return { columns: cols, rows: out, rowCount: affected, affectedRows: affected };
  };
  return { q, close: async () => { await client.end().catch(() => undefined); } };
}

async function connectMssql(rec: ConnectionRecord): Promise<Handle> {
  const connectHost = rec.resolvedIp ?? rec.host;
  const pool = await withTimeout(
    new mssql.ConnectionPool({
      server: connectHost,
      port: rec.port,
      user: rec.user ?? "sa",
      password: rec.password,
      connectionTimeout: CONNECT_TIMEOUT_MS,
      requestTimeout: QUERY_TIMEOUT_MS,
      options: { encrypt: true, trustServerCertificate: process.env.MSSQL_TRUST_SERVER_CERT === "true" }
    }).connect(),
    CONNECT_TIMEOUT_MS + 500,
    "mssql connect"
  );
  const q: QueryFn = async (sql, params) => {
    const req = pool.request();
    let bound = sql;
    if (params && params.length > 0) {
      let i = 0;
      bound = sql.replace(/\?/g, () => `@p${i++}`);
      params.forEach((v, idx) => {
        (req as unknown as { input: (n: string, v: unknown) => void }).input(`p${idx}`, v);
      });
    }
    const result = await withTimeout(
      req.query(bound) as Promise<{ recordset: Record<string, unknown>[]; recordsets: unknown[][]; rowsAffected: number[] }>,
      QUERY_TIMEOUT_MS,
      "mssql query"
    );
    const out = (result.recordset ?? []) as Record<string, unknown>[];
    const cols = out.length > 0 ? Object.keys(out[0]) : [];
    const affected = Array.isArray(result.rowsAffected) && result.rowsAffected.length > 0
      ? result.rowsAffected[result.rowsAffected.length - 1]
      : out.length;
    return { columns: cols, rows: out, rowCount: out.length, affectedRows: affected };
  };
  return { q, close: async () => { await pool.close().catch(() => undefined); } };
}

// ---------- optional per-connection pool (DB_POOL_ENABLED=true) ----------
// Keeps ONE driver handle alive per connectionId, reused across requests, with a
// per-id serial mutex (so single-connection drivers like pg never see concurrent
// queries) and idle eviction. A failed query evicts the handle (no poisoned reuse).
//
// Security note: a pooled handle holds the decrypted credential in driver memory
// until idle close (DB_POOL_IDLE_MS, default 30s) — a bounded extension of the
// existing in-memory connection record (TTL 30m). Disabled by default.

type PoolEntry = { handle: Handle; chain: Promise<unknown>; lastUsed: number };
const pools = new Map<string, Promise<PoolEntry>>();

async function getEntry(rec: ConnectionRecord, driver: DriverType): Promise<PoolEntry> {
  let p = pools.get(rec.id);
  if (!p) {
    p = (async () => {
      const handle = await connect(rec, driver);
      return { handle, chain: Promise.resolve(), lastUsed: Date.now() };
    })();
    pools.set(rec.id, p);
  }
  try {
    return await p;
  } catch (e) {
    pools.delete(rec.id); // creation failed — don't cache the rejected promise
    throw e;
  }
}

function evict(id: string): void {
  const p = pools.get(id);
  if (!p) return;
  pools.delete(id);
  p.then((e) => e.handle.close().catch(() => undefined)).catch(() => undefined);
}

async function runPooled<T>(
  rec: ConnectionRecord,
  driver: DriverType,
  fn: (q: QueryFn, ctx: { driver: DriverType }) => Promise<T>
): Promise<T> {
  const entry = await getEntry(rec, driver);
  // Serialize all work for this connectionId on a single chain.
  const run = entry.chain.then(() => fn(entry.handle.q, { driver }));
  entry.chain = run.then(() => undefined, () => undefined);
  try {
    const result = await run;
    entry.lastUsed = Date.now();
    return result;
  } catch (e) {
    evict(rec.id); // drop possibly-poisoned connection
    throw e;
  }
}

function shutdownPools(): void {
  for (const id of pools.keys()) evict(id);
}

if (POOL_ENABLED) {
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, p] of pools) {
      p.then((e) => {
        if (now - e.lastUsed > POOL_IDLE_MS) evict(id);
      }).catch(() => undefined);
    }
  }, 10_000);
  const unrefable = sweeper as unknown as { unref?: () => void };
  if (typeof unrefable.unref === "function") unrefable.unref();

  if (typeof process !== "undefined" && typeof process.once === "function") {
    process.once("SIGTERM", shutdownPools);
    process.once("SIGINT", shutdownPools);
  }
}
