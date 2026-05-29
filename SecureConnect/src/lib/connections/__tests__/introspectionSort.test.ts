import { describe, test, expect } from "vitest";
import { listRows } from "../introspection";
import type { QueryFn, QueryResult } from "../dbConnector";

function mockQ(rowsForData: Record<string, unknown>[]): { q: QueryFn; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const q: QueryFn = async (sql, params) => {
    calls.push({ sql, params: params ?? [] });
    const res: QueryResult = sql.includes("COUNT(*)")
      ? { columns: ["total"], rows: [{ total: rowsForData.length }], rowCount: 1 }
      : { columns: Object.keys(rowsForData[0] ?? {}), rows: rowsForData, rowCount: rowsForData.length };
    return res;
  };
  return { q, calls };
}

describe("listRows sort", () => {
  test("mysql: ORDER BY quoted column ASC", async () => {
    const { q, calls } = mockQ([{ id: 1 }]);
    await listRows(q, "mysql", "db", "users", 50, 0, { column: "name", dir: "asc" });
    const dataCall = calls.find((c) => !c.sql.includes("COUNT"))!;
    expect(dataCall.sql).toContain("ORDER BY `name` ASC");
  });

  test("postgresql: ORDER BY quoted column DESC", async () => {
    const { q, calls } = mockQ([{ id: 1 }]);
    await listRows(q, "postgresql", "public", "users", 50, 0, { column: "created_at", dir: "desc" });
    const dataCall = calls.find((c) => !c.sql.includes("COUNT"))!;
    expect(dataCall.sql).toContain('ORDER BY "created_at" DESC');
  });

  test("mssql: uses requested ORDER BY (not the NULL fallback)", async () => {
    const { q, calls } = mockQ([{ id: 1 }]);
    await listRows(q, "mssql", "dbo", "Users", 50, 0, { column: "Id", dir: "asc" });
    const dataCall = calls.find((c) => !c.sql.includes("COUNT"))!;
    expect(dataCall.sql).toContain("ORDER BY [Id] ASC");
    expect(dataCall.sql).not.toContain("(SELECT NULL)");
  });

  test("no sort → no ORDER BY for mysql", async () => {
    const { q, calls } = mockQ([{ id: 1 }]);
    await listRows(q, "mysql", "db", "users", 50, 0);
    const dataCall = calls.find((c) => !c.sql.includes("COUNT"))!;
    expect(dataCall.sql).not.toContain("ORDER BY");
  });

  test("invalid sort column is rejected", async () => {
    const { q } = mockQ([{ id: 1 }]);
    await expect(
      listRows(q, "mysql", "db", "users", 50, 0, { column: "name; DROP TABLE x", dir: "asc" })
    ).rejects.toThrow();
  });
});
