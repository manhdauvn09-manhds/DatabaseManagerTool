/**
 * Read-only column statistics + lightweight monitoring helpers.
 * All identifiers are whitelisted + driver-quoted; no user value is interpolated
 * (these operate on schema identifiers only, validated via validateIdent).
 */
import { quoteIdent, validateIdent, type DriverType, type QueryFn } from "./dbConnector";

// Numeric column types across mysql/postgresql/mssql (lowercased dataType prefix match).
const NUMERIC_TYPE_REGEX =
  /^(int|integer|smallint|tinyint|mediumint|bigint|decimal|numeric|float|double|real|money|smallmoney|dec|fixed|number|serial|bigserial)/i;

export function isNumericType(dataType: string): boolean {
  return NUMERIC_TYPE_REGEX.test((dataType ?? "").trim());
}

export type ColumnStats = {
  total: number;
  nonNull: number;
  nulls: number;
  distinct: number;
  min: string | null;
  max: string | null;
  avg: string | null;
  sum: string | null;
  numeric: boolean;
};

function asStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * Compute aggregate statistics for a single column. AVG/SUM only run when the
 * column is numeric (avoids driver errors on text columns in pg/mssql).
 */
export async function columnStats(
  q: QueryFn,
  driver: DriverType,
  database: string,
  table: string,
  column: string,
  numeric: boolean
): Promise<ColumnStats> {
  validateIdent(database, "database");
  validateIdent(table, "table");
  validateIdent(column, "column");

  const fq = `${quoteIdent(database, driver)}.${quoteIdent(table, driver)}`;
  const col = quoteIdent(column, driver);

  const numericCols = numeric ? `, AVG(${col}) AS avgV, SUM(${col}) AS sumV` : "";
  const sql =
    `SELECT COUNT(*) AS total, COUNT(${col}) AS nonNull, COUNT(DISTINCT ${col}) AS distinctCount, ` +
    `MIN(${col}) AS minV, MAX(${col}) AS maxV${numericCols} FROM ${fq}`;

  const r = await q(sql);
  const row = (r.rows[0] ?? {}) as Record<string, unknown>;
  const total = Number(row.total ?? 0);
  const nonNull = Number(row.nonNull ?? 0);

  return {
    total,
    nonNull,
    nulls: Math.max(0, total - nonNull),
    distinct: Number(row.distinctCount ?? 0),
    min: asStr(row.minV),
    max: asStr(row.maxV),
    avg: numeric ? asStr(row.avgV) : null,
    sum: numeric ? asStr(row.sumV) : null,
    numeric
  };
}
