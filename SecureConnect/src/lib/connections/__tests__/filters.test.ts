import { describe, test, expect } from "vitest";
import { buildFilterWhere, listRows, type Filter } from "../introspection";
import type { QueryFn, QueryResult } from "../dbConnector";

describe("buildFilterWhere", () => {
  test("empty → no clause", () => {
    expect(buildFilterWhere([], "mysql")).toEqual({ sql: "", params: [] });
    expect(buildFilterWhere(undefined, "mysql")).toEqual({ sql: "", params: [] });
  });

  test("eq / ne / comparison ops with quoted column + param", () => {
    const r = buildFilterWhere(
      [
        { column: "age", op: "gte", value: "18" },
        { column: "status", op: "ne", value: "banned" }
      ],
      "mysql"
    );
    expect(r.sql).toBe("WHERE `age` >= ? AND `status` <> ?");
    expect(r.params).toEqual(["18", "banned"]);
  });

  test("contains → LIKE %value%", () => {
    const r = buildFilterWhere([{ column: "name", op: "contains", value: "ali" }], "postgresql");
    expect(r.sql).toBe('WHERE "name" LIKE ?');
    expect(r.params).toEqual(["%ali%"]);
  });

  test("mssql bracket quoting", () => {
    const r = buildFilterWhere([{ column: "Id", op: "eq", value: "5" }], "mssql");
    expect(r.sql).toBe("WHERE [Id] = ?");
  });

  test("rejects invalid column (injection)", () => {
    expect(() => buildFilterWhere([{ column: "a; DROP", op: "eq", value: "1" }], "mysql")).toThrow();
  });

  test("rejects invalid op", () => {
    expect(() => buildFilterWhere([{ column: "a", op: "bogus" as Filter["op"], value: "1" }], "mysql")).toThrow();
  });

  test("rejects too many filters", () => {
    const many: Filter[] = Array.from({ length: 11 }, (_, i) => ({ column: `c${i}`, op: "eq" as const, value: "x" }));
    expect(() => buildFilterWhere(many, "mysql")).toThrow(/Too many/);
  });
});

describe("listRows with filters", () => {
  function mockQ(): { q: QueryFn; calls: Array<{ sql: string; params: unknown[] }> } {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const q: QueryFn = async (sql, params) => {
      calls.push({ sql, params: params ?? [] });
      const res: QueryResult = sql.includes("COUNT(*)")
        ? { columns: ["total"], rows: [{ total: 3 }], rowCount: 1 }
        : { columns: ["id"], rows: [{ id: 1 }], rowCount: 1 };
      return res;
    };
    return { q, calls };
  }

  test("filter WHERE applied to BOTH count and data; params ordered", async () => {
    const { q, calls } = mockQ();
    await listRows(q, "mysql", "db", "users", 50, 10, { column: "id", dir: "asc" }, [
      { column: "name", op: "contains", value: "x" }
    ]);
    const countCall = calls.find((c) => c.sql.includes("COUNT(*)"))!;
    const dataCall = calls.find((c) => !c.sql.includes("COUNT(*)"))!;
    expect(countCall.sql).toContain("WHERE `name` LIKE ?");
    expect(countCall.params).toEqual(["%x%"]);
    expect(dataCall.sql).toContain("WHERE `name` LIKE ?");
    expect(dataCall.sql).toContain("ORDER BY `id` ASC");
    // data params: [filter, limit, offset]
    expect(dataCall.params).toEqual(["%x%", 50, 10]);
  });

  test("mssql data params order [filter, offset, limit]", async () => {
    const { q, calls } = mockQ();
    await listRows(q, "mssql", "dbo", "T", 25, 5, undefined, [{ column: "k", op: "eq", value: "v" }]);
    const dataCall = calls.find((c) => !c.sql.includes("COUNT(*)"))!;
    expect(dataCall.sql).toContain("OFFSET ? ROWS FETCH NEXT ? ROWS ONLY");
    expect(dataCall.params).toEqual(["v", 5, 25]);
  });
});
