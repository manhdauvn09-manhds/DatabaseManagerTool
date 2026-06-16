import { describe, it, expect } from "vitest";
import { executeBulkUpdate, executeBulkDelete, bulkPreview } from "../bulkMutate";
import type { SearchQuery } from "../searchBuilder";
import type { QueryResult } from "../dbConnector";

function mockQ(results: QueryResult[]) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  let i = 0;
  const q = async (sql: string, params?: unknown[]): Promise<QueryResult> => {
    calls.push({ sql, params });
    return results[i++] ?? { columns: [], rows: [], rowCount: 0 };
  };
  return { q, calls };
}

const count = (n: number): QueryResult => ({ columns: ["total"], rows: [{ total: n }], rowCount: 1 });
const affected = (n: number): QueryResult => ({ columns: [], rows: [], rowCount: n, affectedRows: n });

const SEARCH: SearchQuery = {
  combinator: "AND",
  groups: [{ combinator: "AND", conditions: [{ column: "status", op: "eq", value: "old" }] }]
};

describe("executeBulkUpdate", () => {
  it("runs UPDATE with SET then WHERE params when under the cap", async () => {
    const { q, calls } = mockQ([count(3), affected(3)]);
    const r = await executeBulkUpdate(q, "mysql", "db", "t", { status: "new" }, SEARCH);
    expect(r.affected).toBe(3);
    // calls[0] = COUNT precheck, calls[1] = UPDATE
    expect(calls[1].sql).toBe("UPDATE `db`.`t` SET `status` = ? WHERE (`status` = ?)");
    expect(calls[1].params).toEqual(["new", "old"]);
  });

  it("refuses when match exceeds the cap (default 100)", async () => {
    const { q } = mockQ([count(9999)]);
    await expect(executeBulkUpdate(q, "mysql", "db", "t", { status: "new" }, SEARCH)).rejects.toThrow(/exceeds cap/i);
  });

  it("rejects an empty SET", async () => {
    const { q } = mockQ([count(1)]);
    await expect(executeBulkUpdate(q, "mysql", "db", "t", {}, SEARCH)).rejects.toThrow(/No columns/i);
  });

  it("rejects an empty WHERE (no groups)", async () => {
    const { q } = mockQ([count(1)]);
    const empty: SearchQuery = { combinator: "AND", groups: [] };
    await expect(executeBulkUpdate(q, "mysql", "db", "t", { status: "new" }, empty)).rejects.toThrow(/WHERE clause is mandatory/i);
  });

  it("rejects an injection attempt in a SET column", async () => {
    const { q } = mockQ([count(1)]);
    await expect(executeBulkUpdate(q, "mysql", "db", "t", { "x; DROP": "1" }, SEARCH)).rejects.toThrow(/Invalid column/i);
  });
});

describe("executeBulkDelete", () => {
  it("runs DELETE when under the cap", async () => {
    const { q, calls } = mockQ([count(2), affected(2)]);
    const r = await executeBulkDelete(q, "mysql", "db", "t", SEARCH);
    expect(r.affected).toBe(2);
    expect(calls[1].sql).toBe("DELETE FROM `db`.`t` WHERE (`status` = ?)");
    expect(calls[1].params).toEqual(["old"]);
  });

  it("refuses when match exceeds the cap", async () => {
    const { q } = mockQ([count(500)]);
    await expect(executeBulkDelete(q, "mysql", "db", "t", SEARCH)).rejects.toThrow(/exceeds cap/i);
  });
});

describe("bulkPreview", () => {
  it("returns total + sample using the search WHERE", async () => {
    const sample: QueryResult = { columns: ["id", "status"], rows: [{ id: 1, status: "old" }], rowCount: 1 };
    const { q, calls } = mockQ([count(1), sample]);
    const r = await bulkPreview(q, "mysql", "db", "t", SEARCH);
    expect(r.total).toBe(1);
    expect(r.columns).toEqual(["id", "status"]);
    expect(calls[0].sql).toContain("SELECT COUNT(*)");
    expect(calls[1].sql).toContain("LIMIT 5");
  });
});
