import { describe, test, expect } from "vitest";
import { quoteIdent, validateIdent } from "../dbConnector";

describe("validateIdent", () => {
  test("accepts valid identifiers", () => {
    expect(() => validateIdent("users")).not.toThrow();
    expect(() => validateIdent("user_123")).not.toThrow();
    expect(() => validateIdent("MyTable")).not.toThrow();
    expect(() => validateIdent("a".repeat(64))).not.toThrow();
  });
  test("rejects empty / too long", () => {
    expect(() => validateIdent("")).toThrow();
    expect(() => validateIdent("a".repeat(65))).toThrow();
  });
  test("rejects shell metacharacters and SQL injection attempts", () => {
    expect(() => validateIdent("users; DROP TABLE x")).toThrow();
    expect(() => validateIdent("users--")).toThrow();
    expect(() => validateIdent("users`")).toThrow();
    expect(() => validateIdent("\"users\"")).toThrow();
    expect(() => validateIdent("users[")).toThrow();
    expect(() => validateIdent("users.")).toThrow();
    expect(() => validateIdent("users ")).toThrow();
    expect(() => validateIdent(" users")).toThrow();
  });
});

describe("quoteIdent", () => {
  test("mysql backticks", () => {
    expect(quoteIdent("users", "mysql")).toBe("`users`");
  });
  test("pg double quotes", () => {
    expect(quoteIdent("Users", "postgresql")).toBe(`"Users"`);
  });
  test("mssql brackets", () => {
    expect(quoteIdent("users", "mssql")).toBe("[users]");
  });
  test("throws on invalid name regardless of driver", () => {
    expect(() => quoteIdent("a;b", "mysql")).toThrow();
    expect(() => quoteIdent("a;b", "postgresql")).toThrow();
    expect(() => quoteIdent("a;b", "mssql")).toThrow();
  });
});
