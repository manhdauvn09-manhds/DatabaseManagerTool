/**
 * Mutation helpers: INSERT, UPDATE, DELETE. Identifier names are whitelisted via
 * validateIdent; values are passed as parameters (never concatenated into SQL).
 *
 * For UPDATE/DELETE:
 *   - WHERE clause is MANDATORY (server rejects empty).
 *   - Server-side row-count cap (MAX_AFFECT_ROWS env, default 100).
 *   - preview returns {sample, total, token}. execute requires {token}.
 */
import { quoteIdent, validateIdent, type DriverType, type QueryFn } from "./dbConnector";

export type CellValue = string | number | boolean | null;
export type RowMap = Record<string, CellValue>;

const DEFAULT_MAX_AFFECT = 100;
export function maxAffectRows(): number {
  const v = Number(process.env.MAX_AFFECT_ROWS ?? DEFAULT_MAX_AFFECT);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_MAX_AFFECT;
}

function validateColumnsList(cols: string[]): void {
  if (cols.length === 0) throw new Error("No columns provided");
  cols.forEach((c) => validateIdent(c, "column"));
}

function buildWhere(where: RowMap, driver: DriverType): { sql: string; params: CellValue[] } {
  const keys = Object.keys(where);
  if (keys.length === 0) throw new Error("WHERE clause is mandatory");
  keys.forEach((k) => validateIdent(k, "column"));
  const parts: string[] = [];
  const params: CellValue[] = [];
  for (const k of keys) {
    const v = where[k];
    const col = quoteIdent(k, driver);
    if (v === null) {
      parts.push(`${col} IS NULL`);
    } else {
      parts.push(`${col} = ?`);
      params.push(v);
    }
  }
  return { sql: parts.join(" AND "), params };
}

function fqTable(database: string, table: string, driver: DriverType): string {
  return `${quoteIdent(database, driver)}.${quoteIdent(table, driver)}`;
}

// ----------------- INSERT -----------------

export async function insertRow(
  q: QueryFn,
  driver: DriverType,
  database: string,
  table: string,
  data: RowMap
): Promise<{ inserted: number; insertId?: number | string }> {
  validateIdent(database, "database");
  validateIdent(table, "table");
  const cols = Object.keys(data);
  validateColumnsList(cols);
  const values = cols.map((c) => data[c]);
  const fq = fqTable(database, table, driver);
  const colList = cols.map((c) => quoteIdent(c, driver)).join(", ");
  const placeholders = cols.map(() => "?").join(", ");
  const sql = `INSERT INTO ${fq} (${colList}) VALUES (${placeholders})`;
  const result = await q(sql, values);
  return { inserted: result.affectedRows ?? 1, insertId: result.insertId };
}

// ----------------- PREVIEW (for UPDATE/DELETE) -----------------

export async function previewMatch(
  q: QueryFn,
  driver: DriverType,
  database: string,
  table: string,
  where: RowMap,
  sampleLimit = 5
): Promise<{ total: number; sample: Record<string, unknown>[]; columns: string[] }> {
  validateIdent(database, "database");
  validateIdent(table, "table");
  const { sql: whereSql, params } = buildWhere(where, driver);
  const fq = fqTable(database, table, driver);
  const totalRes = await q(`SELECT COUNT(*) AS total FROM ${fq} WHERE ${whereSql}`, params);
  const total = Number((totalRes.rows[0] as { total: number | string }).total ?? 0);
  let sampleSql: string;
  if (driver === "mssql") {
    sampleSql = `SELECT TOP ${Math.max(1, Math.floor(sampleLimit))} * FROM ${fq} WHERE ${whereSql}`;
  } else {
    sampleSql = `SELECT * FROM ${fq} WHERE ${whereSql} LIMIT ${Math.max(1, Math.floor(sampleLimit))}`;
  }
  const sample = await q(sampleSql, params);
  return { total, sample: sample.rows, columns: sample.columns };
}

// ----------------- UPDATE -----------------

export async function executeUpdate(
  q: QueryFn,
  driver: DriverType,
  database: string,
  table: string,
  set: RowMap,
  where: RowMap
): Promise<{ affected: number }> {
  validateIdent(database, "database");
  validateIdent(table, "table");
  const setCols = Object.keys(set);
  validateColumnsList(setCols);
  const cap = maxAffectRows();

  // P-1 fix: issue only a COUNT (not COUNT + sample SELECT) for the cap check.
  // This halves DB roundtrips vs. calling previewMatch, which is designed for the
  // preview step already shown to the user.
  const { sql: whereCountSql, params: whereCountParams } = buildWhere(where, driver);
  const fq = fqTable(database, table, driver);
  const countRes = await q(`SELECT COUNT(*) AS total FROM ${fq} WHERE ${whereCountSql}`, whereCountParams);
  const matchCount = Number((countRes.rows[0] as { total: number | string }).total ?? 0);
  if (matchCount > cap) {
    throw new Error(`Operation affects ${matchCount} rows, exceeds cap (${cap}). Refine WHERE or raise MAX_AFFECT_ROWS.`);
  }

  const setSql = setCols.map((c) => `${quoteIdent(c, driver)} = ?`).join(", ");
  const setValues: CellValue[] = setCols.map((c) => set[c]);
  const { sql: whereSql, params: whereParams } = buildWhere(where, driver);
  const sql = `UPDATE ${fq} SET ${setSql} WHERE ${whereSql}`;
  const result = await q(sql, [...setValues, ...whereParams]);
  // C-2 fix: post-check affectedRows to catch the TOCTOU window between COUNT and UPDATE.
  if ((result.affectedRows ?? 0) > cap) {
    throw new Error(`UPDATE affected ${result.affectedRows} rows, exceeds cap (${cap}).`);
  }
  return { affected: result.affectedRows ?? 0 };
}

// ----------------- DELETE -----------------

export async function executeDelete(
  q: QueryFn,
  driver: DriverType,
  database: string,
  table: string,
  where: RowMap
): Promise<{ affected: number; backup?: Record<string, unknown>[] }> {
  validateIdent(database, "database");
  validateIdent(table, "table");
  const cap = maxAffectRows();

  const matched = await previewMatch(q, driver, database, table, where, cap);
  if (matched.total > cap) {
    throw new Error(`DELETE would remove ${matched.total} rows, exceeds cap (${cap}). Refine WHERE or raise MAX_AFFECT_ROWS.`);
  }

  // P-1 fix: reuse the sample rows already fetched by previewMatch instead of issuing
  // a second SELECT * for backup — previewMatch already queried up to cap rows.
  let backup: Record<string, unknown>[] | undefined;
  if (process.env.BACKUP_BEFORE_DELETE === "true") {
    backup = matched.sample;
  }

  const fq = fqTable(database, table, driver);
  const { sql: whereSql, params: whereParams } = buildWhere(where, driver);
  const sql = `DELETE FROM ${fq} WHERE ${whereSql}`;
  const result = await q(sql, whereParams);
  return { affected: result.affectedRows ?? 0, backup };
}

// ----------------- PK helpers -----------------

export function whereHasPrimaryKey(where: RowMap, columns: Array<{ name: string; isPrimaryKey: boolean }>): boolean {
  const pkCols = columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
  if (pkCols.length === 0) return false;
  return pkCols.every((pk) => Object.prototype.hasOwnProperty.call(where, pk));
}
