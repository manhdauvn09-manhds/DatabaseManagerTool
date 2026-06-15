import { describe, it, expect } from "vitest";
import { isNumericType } from "../stats";

describe("isNumericType", () => {
  it.each([
    "int", "integer", "int(11)", "bigint", "smallint", "tinyint(1)", "mediumint",
    "decimal(10,2)", "numeric", "float", "double", "double precision", "real",
    "money", "smallmoney", "serial", "bigserial", "number"
  ])("treats %s as numeric", (t) => {
    expect(isNumericType(t)).toBe(true);
  });

  it.each([
    "varchar(255)", "text", "char(3)", "date", "datetime", "timestamp",
    "boolean", "json", "blob", "enum('a','b')", "uuid", "", "bit"
  ])("treats %s as non-numeric", (t) => {
    expect(isNumericType(t)).toBe(false);
  });
});
