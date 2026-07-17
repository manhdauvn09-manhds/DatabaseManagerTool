import { describe, test, expect } from "vitest";
import { toCsv, toJson, toSqlInserts, csvHeader, csvRowsChunk } from "../exporters";

describe("streaming CSV helpers", () => {
  test("csvHeader escapes and terminates with CRLF", () => {
    expect(csvHeader(["a", "b,c"])).toBe('a,"b,c"\r\n');
  });

  test("csvRowsChunk serialises a batch, one CRLF-terminated line per row", () => {
    const chunk = csvRowsChunk(["a", "b"], [{ a: 1, b: "x" }, { a: 2, b: "y,z" }]);
    expect(chunk).toBe('1,x\r\n2,"y,z"\r\n');
  });

  test("csvHeader + concatenated chunks reproduce toCsv output", () => {
    const cols = ["a", "b"];
    const rows = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
    expect(csvHeader(cols) + csvRowsChunk(cols, rows)).toBe(toCsv(cols, rows));
  });
});

describe("toCsv", () => {
  test("escapes commas, quotes, newlines", () => {
    const csv = toCsv(["a", "b"], [
      { a: "hello,world", b: 'with "quotes"' },
      { a: "line1\nline2", b: null }
    ]);
    expect(csv).toContain('"hello,world"');
    expect(csv).toContain('"with ""quotes"""');
    expect(csv).toContain('"line1\nline2"');
    expect(csv.split("\r\n").length).toBe(4); // header + 2 rows + trailing empty
  });

  test("serializes Date / BigInt / object", () => {
    const csv = toCsv(["d", "n", "o"], [
      { d: new Date("2024-01-02T03:04:05Z"), n: BigInt(123), o: { x: 1 } }
    ]);
    expect(csv).toContain("2024-01-02T03:04:05.000Z");
    expect(csv).toContain("123");
    expect(csv).toContain('"{""x"":1}"');
  });
});

describe("toJson", () => {
  test("emits valid JSON with BigInt as string", () => {
    const j = toJson([{ id: BigInt(9999999999999999n), name: "x" }]);
    const parsed = JSON.parse(j);
    expect(parsed[0].id).toBe("9999999999999999");
    expect(parsed[0].name).toBe("x");
  });
});

describe("toSqlInserts", () => {
  test("mysql backticked identifiers + escape quotes", () => {
    const sql = toSqlInserts("mysql", "db", "users", ["id", "name"], [
      { id: 1, name: "O'Brien" }
    ]);
    expect(sql).toContain("INSERT INTO `db`.`users` (`id`, `name`) VALUES (1, 'O''Brien');");
  });

  test("pg double-quoted identifiers", () => {
    const sql = toSqlInserts("postgresql", "public", "t", ["a"], [{ a: null }]);
    expect(sql).toContain(`INSERT INTO "public"."t" ("a") VALUES (NULL);`);
  });

  test("rejects invalid identifier", () => {
    expect(() => toSqlInserts("mysql", "db", "users;DROP", ["a"], [{ a: 1 }])).toThrow();
  });
});
