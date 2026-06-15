import { describe, it, expect } from "vitest";
import { validateSql } from "./sqlValidator";

describe("sqlValidator", () => {
  it("allows SELECT", () => {
    const result = validateSql("SELECT * FROM users");
    expect(result.ok).toBe(true);
    expect(result.isExplain).toBe(false);
  });

  it("allows SELECT with WHERE", () => {
    const result = validateSql("SELECT id, name FROM users WHERE active = 1");
    expect(result.ok).toBe(true);
  });

  it("allows EXPLAIN", () => {
    const result = validateSql("EXPLAIN SELECT * FROM users");
    expect(result.ok).toBe(true);
    expect(result.isExplain).toBe(true);
  });

  it("allows WITH (CTE)", () => {
    const result = validateSql("WITH cte AS (SELECT 1) SELECT * FROM cte");
    expect(result.ok).toBe(true);
  });

  it("allows SHOW", () => {
    const result = validateSql("SHOW TABLES");
    expect(result.ok).toBe(true);
  });

  it("allows DESC", () => {
    const result = validateSql("DESC users");
    expect(result.ok).toBe(true);
  });

  it("blocks INSERT", () => {
    const result = validateSql("INSERT INTO users (name) VALUES ('test')");
    expect(result.ok).toBe(false);
    // Either guard may fire first (whitelist prefix or dangerous-keyword scan).
    expect(result.error).toMatch(/Only SELECT|Write operations|INSERT/i);
  });

  it("blocks UPDATE", () => {
    const result = validateSql("UPDATE users SET name = 'test' WHERE id = 1");
    expect(result.ok).toBe(false);
  });

  it("blocks DELETE", () => {
    const result = validateSql("DELETE FROM users WHERE id = 1");
    expect(result.ok).toBe(false);
  });

  it("blocks DROP", () => {
    const result = validateSql("DROP TABLE users");
    expect(result.ok).toBe(false);
  });

  it("blocks ALTER", () => {
    const result = validateSql("ALTER TABLE users ADD COLUMN email VARCHAR(100)");
    expect(result.ok).toBe(false);
  });

  it("blocks CREATE", () => {
    const result = validateSql("CREATE TABLE users (id INT)");
    expect(result.ok).toBe(false);
  });

  it("rejects empty SQL", () => {
    const result = validateSql("");
    expect(result.ok).toBe(false);
  });

  it("rejects whitespace-only SQL", () => {
    const result = validateSql("   \n\t  ");
    expect(result.ok).toBe(false);
  });

  it("rejects overly long SQL", () => {
    const result = validateSql("SELECT " + "1, ".repeat(30000));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/too long/i);
  });

  it("handles case-insensitive keywords", () => {
    const result = validateSql("select * from users");
    expect(result.ok).toBe(true);
  });

  it("blocks INSERT with variations", () => {
    const result = validateSql("  \n  INSERT INTO users VALUES (1)  ");
    expect(result.ok).toBe(false);
  });

  it("allows PRAGMA (SQLite)", () => {
    const result = validateSql("PRAGMA table_info(users)");
    expect(result.ok).toBe(true);
  });
});
