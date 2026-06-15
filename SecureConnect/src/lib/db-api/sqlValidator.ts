/**
 * Validate SQL — ensure read-only (SELECT/EXPLAIN only, no DDL/DML).
 */

const WHITELIST_REGEX = /^\s*(?:EXPLAIN|SELECT|WITH|DESC|SHOW|DESCRIBE|PRAGMA)[\s\S]*$/i;
const DANGEROUS_KEYWORDS = /\b(?:INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|CALL|EXEC|GRANT|REVOKE|BEGIN|COMMIT|ROLLBACK|LOCK|UNLOCK|SAVEPOINT)\b/i;

export interface SqlValidationResult {
  ok: boolean;
  error?: string;
  isExplain?: boolean;
}

/**
 * Validate SQL for safe execution:
 * - Only SELECT, EXPLAIN, WITH, DESC, SHOW, PRAGMA allowed
 * - No INSERT/UPDATE/DELETE/DDL
 */
export function validateSql(sql: string): SqlValidationResult {
  if (!sql || typeof sql !== "string") {
    return { ok: false, error: "SQL cannot be empty" };
  }

  const trimmed = sql.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "SQL cannot be empty" };
  }
  if (trimmed.length > 50_000) {
    return { ok: false, error: "SQL too long (max 50KB)" };
  }

  // Check format
  if (!WHITELIST_REGEX.test(trimmed)) {
    return { ok: false, error: "Only SELECT, EXPLAIN, WITH, SHOW, DESC, PRAGMA allowed" };
  }

  // Double-check dangerous keywords
  if (DANGEROUS_KEYWORDS.test(trimmed)) {
    return { ok: false, error: "Write operations (INSERT/UPDATE/DELETE/DDL) not allowed" };
  }

  const isExplain = /^\s*EXPLAIN/i.test(trimmed);

  return { ok: true, isExplain };
}
