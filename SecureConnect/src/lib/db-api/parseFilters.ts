import { FILTER_OPS, type Filter, type FilterOp } from "@/lib/connections/introspection";

/**
 * Parse the `filters` query param (URL-encoded JSON array) into a validated
 * Filter[]. Returns [] for missing/empty. Throws on malformed input so the
 * route can return 400.
 */
export function parseFiltersParam(raw: string | null): Filter[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("filters must be valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("filters must be an array");
  if (parsed.length > 10) throw new Error("Too many filters (max 10)");
  return parsed.map((f, i) => {
    if (!f || typeof f !== "object") throw new Error(`filter[${i}] invalid`);
    const obj = f as Record<string, unknown>;
    const column = obj.column;
    const op = obj.op;
    const value = obj.value;
    if (typeof column !== "string" || !column) throw new Error(`filter[${i}].column required`);
    if (typeof op !== "string" || !FILTER_OPS.includes(op as FilterOp)) throw new Error(`filter[${i}].op invalid`);
    if (typeof value !== "string") throw new Error(`filter[${i}].value must be a string`);
    if (value.length > 1024) throw new Error(`filter[${i}].value too long`);
    return { column, op: op as FilterOp, value };
  });
}
