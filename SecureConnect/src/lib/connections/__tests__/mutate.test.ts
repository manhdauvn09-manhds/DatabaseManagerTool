import { describe, test, expect } from "vitest";
import { insertRow, previewMatch, executeUpdate, executeDelete, whereHasPrimaryKey } from "../mutate";
import type { QueryFn, QueryResult } from "../dbConnector";

// Captures the last invocation so we can assert SQL + params.
function makeMockQ(responseFor: (sql: string) => QueryResult): { q: QueryFn; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const q: QueryFn = async (sql, params) => {
    calls.push({ sql, params: params ?? [] });
    return responseFor(sql);
  };
  return { q, calls };
}

describe("insertRow", () => {
  test("mysql: builds correct INSERT", async () => {
    const { q, calls } = makeMockQ(() => ({ columns: [], rows: [], rowCount: 1, affectedRows: 1, insertId: 42 }));
    const r = await insertRow(q, "mysql", "mydb", "users", { name: "Alice", age: 30, bio: null });
    expect(r.inserted).toBe(1);
    expect(r.insertId).toBe(42);
    expect(calls[0].sql).toBe("INSERT INTO `mydb`.`users` (`name`, `age`, `bio`) VALUES (?, ?, ?)");
    expect(calls[0].params).toEqual(["Alice", 30, null]);
  });

  test("postgresql: uses ? (translated by driver wrapper)", async () => {
    const { q, calls } = makeMockQ(() => ({ columns: [], rows: [], rowCount: 1, affectedRows: 1 }));
    await insertRow(q, "postgresql", "public", "users", { name: "Bob" });
    expect(calls[0].sql).toBe(`INSERT INTO "public"."users" ("name") VALUES (?)`);
  });

  test("mssql: bracket-quoted identifiers", async () => {
    const { q, calls } = makeMockQ(() => ({ columns: [], rows: [], rowCount: 1, affectedRows: 1 }));
    await insertRow(q, "mssql", "dbo", "Users", { Name: "Carol" });
    expect(calls[0].sql).toBe("INSERT INTO [dbo].[Users] ([Name]) VALUES (?)");
  });

  test("rejects invalid identifier", async () => {
    const { q } = makeMockQ(() => ({ columns: [], rows: [], rowCount: 0 }));
    await expect(insertRow(q, "mysql", "x;DROP", "users", { name: "a" })).rejects.toThrow();
    await expect(insertRow(q, "mysql", "db", "users", { "name; DROP": "a" })).rejects.toThrow();
  });

  test("rejects empty data", async () => {
    const { q } = makeMockQ(() => ({ columns: [], rows: [], rowCount: 0 }));
    await expect(insertRow(q, "mysql", "db", "users", {})).rejects.toThrow();
  });
});

describe("previewMatch", () => {
  test("builds WHERE with IS NULL for null values", async () => {
    const { q, calls } = makeMockQ((sql) => {
      if (sql.startsWith("SELECT COUNT")) return { columns: ["total"], rows: [{ total: 7 }], rowCount: 1 };
      return { columns: ["id"], rows: [{ id: 1 }], rowCount: 1 };
    });
    const r = await previewMatch(q, "mysql", "db", "users", { email: null, status: "active" }, 5);
    expect(r.total).toBe(7);
    expect(calls[0].sql).toContain("WHERE `email` IS NULL AND `status` = ?");
    expect(calls[0].params).toEqual(["active"]);
  });

  test("mssql uses TOP not LIMIT", async () => {
    const { q, calls } = makeMockQ((sql) => {
      if (sql.startsWith("SELECT COUNT")) return { columns: ["total"], rows: [{ total: 1 }], rowCount: 1 };
      return { columns: [], rows: [], rowCount: 0 };
    });
    await previewMatch(q, "mssql", "dbo", "Users", { id: 1 }, 5);
    expect(calls[1].sql).toContain("TOP 5");
    expect(calls[1].sql).not.toContain("LIMIT");
  });
});

describe("executeUpdate", () => {
  test("rejects when row count > cap", async () => {
    const { q } = makeMockQ(() => ({ columns: ["total"], rows: [{ total: 5000 }], rowCount: 1 }));
    await expect(
      executeUpdate(q, "mysql", "db", "users", { status: "ok" }, { tenant_id: 1 })
    ).rejects.toThrow(/exceeds cap/);
  });

  test("happy path: emits UPDATE with correct SET + WHERE", async () => {
    const { q, calls } = makeMockQ((sql) => {
      if (sql.startsWith("SELECT COUNT")) return { columns: ["total"], rows: [{ total: 1 }], rowCount: 1 };
      if (sql.startsWith("UPDATE")) return { columns: [], rows: [], rowCount: 1, affectedRows: 1 };
      return { columns: [], rows: [], rowCount: 0 };
    });
    const r = await executeUpdate(q, "mysql", "db", "users", { name: "New" }, { id: 7 });
    expect(r.affected).toBe(1);
    const updateCall = calls.find((c) => c.sql.startsWith("UPDATE"))!;
    expect(updateCall.sql).toBe("UPDATE `db`.`users` SET `name` = ? WHERE `id` = ?");
    expect(updateCall.params).toEqual(["New", 7]);
  });

  test("rejects empty WHERE", async () => {
    const { q } = makeMockQ(() => ({ columns: ["total"], rows: [{ total: 0 }], rowCount: 0 }));
    await expect(executeUpdate(q, "mysql", "db", "users", { name: "x" }, {})).rejects.toThrow(/WHERE/);
  });
});

describe("executeDelete", () => {
  test("rejects when count > cap", async () => {
    const { q } = makeMockQ(() => ({ columns: ["total"], rows: [{ total: 200 }], rowCount: 1 }));
    await expect(executeDelete(q, "mysql", "db", "users", { tenant_id: 1 })).rejects.toThrow(/exceeds cap/);
  });

  test("happy path emits DELETE", async () => {
    const { q, calls } = makeMockQ((sql) => {
      if (sql.startsWith("SELECT COUNT")) return { columns: ["total"], rows: [{ total: 1 }], rowCount: 1 };
      if (sql.startsWith("DELETE")) return { columns: [], rows: [], rowCount: 1, affectedRows: 1 };
      return { columns: [], rows: [], rowCount: 0 };
    });
    const r = await executeDelete(q, "mysql", "db", "users", { id: 5 });
    expect(r.affected).toBe(1);
    const del = calls.find((c) => c.sql.startsWith("DELETE"))!;
    expect(del.sql).toBe("DELETE FROM `db`.`users` WHERE `id` = ?");
    expect(del.params).toEqual([5]);
  });
});

describe("whereHasPrimaryKey", () => {
  test("true when all PK columns in WHERE", () => {
    expect(whereHasPrimaryKey({ id: 1 }, [
      { name: "id", isPrimaryKey: true },
      { name: "name", isPrimaryKey: false }
    ])).toBe(true);
  });
  test("false when missing a PK col", () => {
    expect(whereHasPrimaryKey({ name: "x" }, [
      { name: "id", isPrimaryKey: true },
      { name: "name", isPrimaryKey: false }
    ])).toBe(false);
  });
  test("false when table has no PK", () => {
    expect(whereHasPrimaryKey({ id: 1 }, [
      { name: "id", isPrimaryKey: false }
    ])).toBe(false);
  });
});
