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

export async function withConnection<T>(
  rec: ConnectionRecord,
  fn: (q: QueryFn, ctx: { driver: DriverType }) => Promise<T>
): Promise<T> {
  const driver = rec.dbType as DriverType;
  if (driver === "mysql") return withMysql(rec, fn);
  if (driver === "postgresql") return withPg(rec, fn);
  if (driver === "mssql") return withMssql(rec, fn);
  throw new Error(`Unsupported driver: ${driver}`);
}

async function withMysql<T>(rec: ConnectionRecord, fn: (q: QueryFn, ctx: { driver: DriverType }) => Promise<T>): Promise<T> {
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
      dateStrings: true
    }),
    CONNECT_TIMEOUT_MS + 500,
    "mysql connect"
  );
  try {
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
      // ResultSetHeader (INSERT/UPDATE/DELETE)
      const rsh = data as mysql.ResultSetHeader;
      return {
        columns: [],
        rows: [],
        rowCount: rsh.affectedRows ?? 0,
        affectedRows: rsh.affectedRows,
        insertId: rsh.insertId !== undefined && rsh.insertId !== 0 ? rsh.insertId : undefined
      };
    };
    return await fn(q, { driver: "mysql" });
  } finally {
    await conn.end().catch(() => undefined);
  }
}

async function withPg<T>(rec: ConnectionRecord, fn: (q: QueryFn, ctx: { driver: DriverType }) => Promise<T>): Promise<T> {
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
  try {
    const q: QueryFn = async (sql, params) => {
      // Translate ?-placeholders to $N so callers can use ? uniformly across drivers.
      let bound = sql;
      if (params && params.length > 0 && bound.includes("?")) {
        let i = 0;
        bound = bound.replace(/\?/g, () => `$${++i}`);
      }
      const result = await withTimeout(
        client.query(bound, params),
        QUERY_TIMEOUT_MS,
        "pg query"
      );
      const cols = result.fields?.map((f) => f.name) ?? [];
      const out = (result.rows ?? []) as Record<string, unknown>[];
      const affected = result.rowCount ?? out.length;
      return { columns: cols, rows: out, rowCount: affected, affectedRows: affected };
    };
    return await fn(q, { driver: "postgresql" });
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function withMssql<T>(rec: ConnectionRecord, fn: (q: QueryFn, ctx: { driver: DriverType }) => Promise<T>): Promise<T> {
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
  try {
    const q: QueryFn = async (sql, params) => {
      const req = pool.request();
      // mssql uses @paramName binding. We emulate positional ? by replacing with @pN.
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
    return await fn(q, { driver: "mssql" });
  } finally {
    await pool.close().catch(() => undefined);
  }
}
