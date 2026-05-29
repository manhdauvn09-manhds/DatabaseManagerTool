import { describe, test, expect } from "vitest";
import { parseFiltersParam } from "../parseFilters";

describe("parseFiltersParam", () => {
  test("null/empty → []", () => {
    expect(parseFiltersParam(null)).toEqual([]);
    expect(parseFiltersParam("")).toEqual([]);
  });

  test("valid JSON array parsed", () => {
    const raw = JSON.stringify([{ column: "name", op: "contains", value: "x" }]);
    expect(parseFiltersParam(raw)).toEqual([{ column: "name", op: "contains", value: "x" }]);
  });

  test("invalid JSON throws", () => {
    expect(() => parseFiltersParam("{not json")).toThrow(/valid JSON/);
  });

  test("non-array throws", () => {
    expect(() => parseFiltersParam(JSON.stringify({ a: 1 }))).toThrow(/array/);
  });

  test("bad op throws", () => {
    expect(() => parseFiltersParam(JSON.stringify([{ column: "a", op: "x", value: "1" }]))).toThrow(/op invalid/);
  });

  test("missing column throws", () => {
    expect(() => parseFiltersParam(JSON.stringify([{ op: "eq", value: "1" }]))).toThrow(/column required/);
  });

  test("non-string value throws", () => {
    expect(() => parseFiltersParam(JSON.stringify([{ column: "a", op: "eq", value: 1 }]))).toThrow(/must be a string/);
  });

  test("too many throws", () => {
    const many = JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ column: `c${i}`, op: "eq", value: "x" })));
    expect(() => parseFiltersParam(many)).toThrow(/Too many/);
  });
});
