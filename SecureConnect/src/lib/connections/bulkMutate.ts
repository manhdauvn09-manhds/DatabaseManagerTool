/**
 * Bulk UPDATE / DELETE over a filter (Advanced-Search WHERE), gated by the same
 * safety machinery as single-row mutations:
 *   - WHERE is MANDATORY (a SearchQuery with ≥1 condition; empty predicate rejected).
 *   - Server-side row cap (MAX_AFFECT_ROWS, default 100) — refuse if match exceeds it.
 *   - Values bound as parameters; identifiers whitelisted + driver-quoted.
 *   - Route layer adds preview → single-use confirm-token → execute.
 *
 * Reuses buildSearchWhere (parametrized, tested) so the bulk predicate shares the
 * exact same SQL-building path as read-only search.
 */
import { quoteIdent, validateIdent, type DriverType, type QueryFn } from "./dbConnector";
import { buildSearchWhere, type SearchQuery } from "./searchBuilder";
import { maxAffectRows, type RowMap, type CellValue } from "./mutate";

function fqTable(database: string, table: string, driver: DriverType): string {
  return `${quoteIdent(database, driver)}.${quoteIdent(table, driver)}`;
}

function whereOrThrow(search: SearchQuery, driver: DriverType): { sql: string; params: unknown[] } {
  const where = buildSearchWhere(search, driver);
  if (!where.sql) throw new Error("WHERE clause is mandatory");
  return where;
}

export async function bulkPreview(
  q: QueryFn,
  driver: DriverType,
  database: string,
  table: string,
  search: SearchQuery,
  sampleLimit = 5
): Promise<{ total: number; sample: Record<string, unknown>[]; columns: string[] }> {
  validateIdent(database, "database");
  validateIdent(table, "table");
  const where = whereOrThrow(search, driver);
  const fq = fqTable(database, table, driver);

  const totalRes = await q(`SELECT COUNT(*) AS total FROM ${fq} ${where.sql}`, where.params);
  const total = Number((totalRes.rows[0] as { total: number | string }).total ?? 0);

  const n = Math.max(1, Math.floor(sampleLimit));
  const sampleSql =
    driver === "mssql"
      ? `SELECT TOP ${n} * FROM ${fq} ${where.sql}`
      : `SELECT * FROM ${fq} ${where.sql} LIMIT ${n}`;
  const sample = await q(sampleSql, where.params);
  return { total, sample: sample.rows, columns: sample.columns };
}

export async function executeBulkUpdate(
  q: QueryFn,
  driver: DriverType,
  database: string,
  table: string,
  set: RowMap,
  search: SearchQuery
): Promise<{ affected: number }> {
  validateIdent(database, "database");
  validateIdent(table, "table");
  const setCols = Object.keys(set);
  if (setCols.length === 0) throw new Error("No columns provided");
  setCols.forEach((c) => validateIdent(c, "column"));

  const cap = maxAffectRows();
  const where = whereOrThrow(search, driver);
  const fq = fqTable(database, table, driver);

  const totalRes = await q(`SELECT COUNT(*) AS total FROM ${fq} ${where.sql}`, where.params);
  const total = Number((totalRes.rows[0] as { total: number | string }).total ?? 0);
  if (total > cap) {
    throw new Error(`Operation affects ${total} rows, exceeds cap (${cap}). Refine the filter or raise MAX_AFFECT_ROWS.`);
  }

  const setSql = setCols.map((c) => `${quoteIdent(c, driver)} = ?`).join(", ");
  const setValues: CellValue[] = setCols.map((c) => set[c]);
  const sql = `UPDATE ${fq} SET ${setSql} ${where.sql}`;
  const result = await q(sql, [...setValues, ...where.params]);
  return { affected: result.affectedRows ?? 0 };
}

export async function executeBulkDelete(
  q: QueryFn,
  driver: DriverType,
  database: string,
  table: string,
  search: SearchQuery
): Promise<{ affected: number; backup?: Record<string, unknown>[] }> {
  validateIdent(database, "database");
  validateIdent(table, "table");

  const cap = maxAffectRows();
  const where = whereOrThrow(search, driver);
  const fq = fqTable(database, table, driver);

  const totalRes = await q(`SELECT COUNT(*) AS total FROM ${fq} ${where.sql}`, where.params);
  const total = Number((totalRes.rows[0] as { total: number | string }).total ?? 0);
  if (total > cap) {
    throw new Error(`DELETE would remove ${total} rows, exceeds cap (${cap}). Refine the filter or raise MAX_AFFECT_ROWS.`);
  }

  let backup: Record<string, unknown>[] | undefined;
  if (process.env.BACKUP_BEFORE_DELETE === "true") {
    const all = await q(`SELECT * FROM ${fq} ${where.sql}`, where.params);
    backup = all.rows;
  }

  const sql = `DELETE FROM ${fq} ${where.sql}`;
  const result = await q(sql, where.params);
  return { affected: result.affectedRows ?? 0, backup };
}
