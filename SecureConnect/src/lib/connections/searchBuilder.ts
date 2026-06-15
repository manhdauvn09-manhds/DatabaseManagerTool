/**
 * Advanced search WHERE builder — a bounded 2-level boolean tree:
 *   topCombinator over groups, each group = combinator over conditions.
 *   → e.g. (a AND b) OR (c AND d)
 *
 * SECURITY: column identifiers are whitelisted + driver-quoted (quoteIdent);
 * EVERY value is bound as a parameter (`?`, translated to $N/@pN by the driver
 * wrappers). No user value is ever concatenated into SQL text.
 *
 * Kept separate from the proven listRows / buildFilterWhere browse path so the
 * richer operator set can evolve without regressing simple browse filters.
 */
import { quoteIdent, validateIdent, type DriverType, type QueryFn } from "./dbConnector";
import { orderClause, type OrderBy } from "./introspection";

export type SearchOp =
  | "eq" | "ne"
  | "gt" | "lt" | "gte" | "lte"
  | "contains" | "not_contains" | "starts_with" | "ends_with"
  | "in" | "between"
  | "is_null" | "is_not_null";

export const SEARCH_OPS: SearchOp[] = [
  "eq", "ne", "gt", "lt", "gte", "lte",
  "contains", "not_contains", "starts_with", "ends_with",
  "in", "between", "is_null", "is_not_null"
];

// Ops that take no value (unary predicates).
const NO_VALUE_OPS = new Set<SearchOp>(["is_null", "is_not_null"]);

export type Combinator = "AND" | "OR";

export type SearchCondition = {
  column: string;
  op: SearchOp;
  value?: string;   // for in: comma-separated; for between: lower bound
  value2?: string;  // for between: upper bound
};

export type SearchGroup = {
  combinator: Combinator;
  conditions: SearchCondition[];
};

export type SearchQuery = {
  combinator: Combinator;
  groups: SearchGroup[];
};

// Caps — keep query bounded + predictable.
const MAX_GROUPS = 5;
const MAX_CONDITIONS_PER_GROUP = 10;
const MAX_TOTAL_CONDITIONS = 30;
const MAX_IN_ITEMS = 50;
const MAX_VALUE_LEN = 1024;

const SIMPLE_OP_SQL: Record<"eq" | "ne" | "gt" | "lt" | "gte" | "lte", string> = {
  eq: "=", ne: "<>", gt: ">", lt: "<", gte: ">=", lte: "<="
};

function isCombinator(v: unknown): v is Combinator {
  return v === "AND" || v === "OR";
}

/**
 * Validate + normalize a raw object into a SearchQuery. Throws on malformed
 * input so the route can return 400.
 */
export function parseSearchQuery(raw: unknown): SearchQuery {
  if (!raw || typeof raw !== "object") throw new Error("search must be an object");
  const obj = raw as Record<string, unknown>;
  const combinator = obj.combinator ?? "AND";
  if (!isCombinator(combinator)) throw new Error("combinator must be AND or OR");
  if (!Array.isArray(obj.groups)) throw new Error("groups must be an array");
  if (obj.groups.length === 0) throw new Error("at least one group required");
  if (obj.groups.length > MAX_GROUPS) throw new Error(`Too many groups (max ${MAX_GROUPS})`);

  let total = 0;
  const groups: SearchGroup[] = obj.groups.map((g, gi) => {
    if (!g || typeof g !== "object") throw new Error(`group[${gi}] invalid`);
    const go = g as Record<string, unknown>;
    const gc = go.combinator ?? "AND";
    if (!isCombinator(gc)) throw new Error(`group[${gi}].combinator must be AND or OR`);
    if (!Array.isArray(go.conditions) || go.conditions.length === 0) {
      throw new Error(`group[${gi}] needs at least one condition`);
    }
    if (go.conditions.length > MAX_CONDITIONS_PER_GROUP) {
      throw new Error(`group[${gi}] too many conditions (max ${MAX_CONDITIONS_PER_GROUP})`);
    }
    const conditions: SearchCondition[] = go.conditions.map((c, ci) => {
      if (!c || typeof c !== "object") throw new Error(`group[${gi}].condition[${ci}] invalid`);
      const co = c as Record<string, unknown>;
      const column = co.column;
      const op = co.op;
      if (typeof column !== "string" || !column) throw new Error(`group[${gi}].condition[${ci}].column required`);
      if (typeof op !== "string" || !SEARCH_OPS.includes(op as SearchOp)) {
        throw new Error(`group[${gi}].condition[${ci}].op invalid`);
      }
      const cond: SearchCondition = { column, op: op as SearchOp };
      if (!NO_VALUE_OPS.has(op as SearchOp)) {
        if (typeof co.value !== "string") throw new Error(`group[${gi}].condition[${ci}].value required`);
        if (co.value.length > MAX_VALUE_LEN) throw new Error(`group[${gi}].condition[${ci}].value too long`);
        cond.value = co.value;
        if (op === "between") {
          if (typeof co.value2 !== "string") throw new Error(`group[${gi}].condition[${ci}].value2 required for between`);
          if (co.value2.length > MAX_VALUE_LEN) throw new Error(`group[${gi}].condition[${ci}].value2 too long`);
          cond.value2 = co.value2;
        }
      }
      total += 1;
      return cond;
    });
    return { combinator: gc, conditions };
  });

  if (total > MAX_TOTAL_CONDITIONS) throw new Error(`Too many conditions total (max ${MAX_TOTAL_CONDITIONS})`);
  return { combinator, groups };
}

// Build the SQL fragment + params for a single condition.
function conditionSql(c: SearchCondition, driver: DriverType): { sql: string; params: unknown[] } {
  validateIdent(c.column, "search column");
  const col = quoteIdent(c.column, driver);

  switch (c.op) {
    case "eq": case "ne": case "gt": case "lt": case "gte": case "lte":
      return { sql: `${col} ${SIMPLE_OP_SQL[c.op]} ?`, params: [c.value] };
    case "contains":
      return { sql: `${col} LIKE ?`, params: [`%${c.value}%`] };
    case "not_contains":
      return { sql: `${col} NOT LIKE ?`, params: [`%${c.value}%`] };
    case "starts_with":
      return { sql: `${col} LIKE ?`, params: [`${c.value}%`] };
    case "ends_with":
      return { sql: `${col} LIKE ?`, params: [`%${c.value}`] };
    case "is_null":
      return { sql: `${col} IS NULL`, params: [] };
    case "is_not_null":
      return { sql: `${col} IS NOT NULL`, params: [] };
    case "in": {
      const items = (c.value ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      if (items.length === 0) throw new Error(`'in' needs at least one value for ${c.column}`);
      if (items.length > MAX_IN_ITEMS) throw new Error(`'in' too many values (max ${MAX_IN_ITEMS})`);
      const placeholders = items.map(() => "?").join(", ");
      return { sql: `${col} IN (${placeholders})`, params: items };
    }
    case "between":
      return { sql: `${col} BETWEEN ? AND ?`, params: [c.value, c.value2] };
    default:
      throw new Error(`Unsupported op: ${c.op}`);
  }
}

/**
 * Build a parametrized WHERE from a validated SearchQuery.
 * Returns { sql: "WHERE (...) AND/OR (...)", params } or { sql: "", params: [] }.
 */
export function buildSearchWhere(query: SearchQuery, driver: DriverType): { sql: string; params: unknown[] } {
  const groupSqls: string[] = [];
  const params: unknown[] = [];

  for (const g of query.groups) {
    const condSqls: string[] = [];
    for (const c of g.conditions) {
      const built = conditionSql(c, driver);
      condSqls.push(built.sql);
      params.push(...built.params);
    }
    if (condSqls.length === 0) continue;
    groupSqls.push(`(${condSqls.join(` ${g.combinator} `)})`);
  }

  if (groupSqls.length === 0) return { sql: "", params: [] };
  return { sql: `WHERE ${groupSqls.join(` ${query.combinator} `)}`, params };
}

/**
 * Run an advanced search: COUNT(*) + paginated SELECT *, mirroring listRows
 * pagination semantics (mssql OFFSET/FETCH requires ORDER BY).
 */
export async function searchRows(
  q: QueryFn,
  driver: DriverType,
  database: string,
  table: string,
  query: SearchQuery,
  limit: number,
  offset: number,
  orderBy?: OrderBy
): Promise<{ columns: string[]; rows: Record<string, unknown>[]; total: number }> {
  validateIdent(database, "database");
  validateIdent(table, "table");

  const lim = Math.max(1, Math.min(1000, Math.floor(limit)));
  const off = Math.max(0, Math.floor(offset));
  const order = orderClause(orderBy, driver);
  const where = buildSearchWhere(query, driver);
  const fq = `${quoteIdent(database, driver)}.${quoteIdent(table, driver)}`;

  const totalRes = await q(`SELECT COUNT(*) AS total FROM ${fq} ${where.sql}`, where.params);
  const total = Number((totalRes.rows[0] as { total: number | string }).total ?? 0);

  let data;
  if (driver === "mssql") {
    const mssqlOrder = order || "ORDER BY (SELECT NULL)";
    data = await q(
      `SELECT * FROM ${fq} ${where.sql} ${mssqlOrder} OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`,
      [...where.params, off, lim]
    );
  } else {
    data = await q(
      `SELECT * FROM ${fq} ${where.sql} ${order} LIMIT ? OFFSET ?`,
      [...where.params, lim, off]
    );
  }
  return { columns: data.columns, rows: data.rows, total };
}
