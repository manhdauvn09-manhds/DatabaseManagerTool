/**
 * Execute arbitrary SQL queries (SELECT/EXPLAIN/SHOW/etc) via QueryFn.
 * Handles timeouts + error wrapping.
 */
import type { DriverType, QueryFn, QueryResult } from "./dbConnector";

const QUERY_TIMEOUT_MS = 30000; // 30s for long-running reports

export interface ExecuteQueryOptions {
  limit?: number;
  timeout?: number;
}

export interface ExecuteQueryResult extends QueryResult {
  executionTimeMs: number;
  isExplain?: boolean;
}

/**
 * Execute a raw SQL query, measure execution time, cap rows.
 * @param q Query function from withConnection
 * @param sql Raw SQL (must be pre-validated as read-only)
 * @param driver For query building (mysql/pg/mssql)
 * @param opts limit, timeout
 */
export async function executeQuery(
  q: QueryFn,
  sql: string,
  driver: DriverType,
  opts: ExecuteQueryOptions = {}
): Promise<ExecuteQueryResult> {
  const isExplain = /^\s*EXPLAIN/i.test(sql);
  const limit = opts.limit ?? 1000;
  const timeout = opts.timeout ?? QUERY_TIMEOUT_MS;

  // Strip a single trailing semicolon + whitespace so we can safely append LIMIT.
  const base = sql.replace(/;\s*$/, "").trimEnd();

  // Add LIMIT clause for SELECT (unless already present) to prevent runaway queries
  let finalSql = base;
  if (!isExplain && !/\bLIMIT\s+\d+/i.test(base)) {
    // Only add if it looks like a SELECT without a LIMIT
    if (/^\s*(?:SELECT|WITH)/i.test(base)) {
      // MySQL/PostgreSQL syntax
      if (driver === "postgresql" || driver === "mysql") {
        finalSql = `${base}\nLIMIT ${limit}`;
      } else if (driver === "mssql") {
        // MSSQL: prepend TOP if no existing TOP
        if (!/\bTOP\s+\d+/i.test(base)) {
          finalSql = base.replace(/^\s*SELECT\s+/i, `SELECT TOP ${limit} `);
        }
      }
    }
  }

  const t0 = performance.now();
  try {
    const result = await withTimeout(q(finalSql), timeout);
    const executionTimeMs = Math.round(performance.now() - t0);
    return { ...result, executionTimeMs, isExplain };
  } catch (e) {
    const executionTimeMs = Math.round(performance.now() - t0);
    throw new Error(
      `Query failed after ${executionTimeMs}ms: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Query timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}
