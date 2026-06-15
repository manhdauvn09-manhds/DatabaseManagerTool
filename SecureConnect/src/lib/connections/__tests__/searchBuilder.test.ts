import { describe, it, expect } from "vitest";
import {
  parseSearchQuery,
  buildSearchWhere,
  type SearchQuery
} from "../searchBuilder";

function q(groups: SearchQuery["groups"], combinator: "AND" | "OR" = "AND"): SearchQuery {
  return { combinator, groups };
}

describe("parseSearchQuery", () => {
  it("accepts a minimal valid query", () => {
    const parsed = parseSearchQuery({
      combinator: "AND",
      groups: [{ combinator: "AND", conditions: [{ column: "id", op: "eq", value: "1" }] }]
    });
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0].conditions[0].op).toBe("eq");
  });

  it("defaults combinator to AND", () => {
    const parsed = parseSearchQuery({
      groups: [{ conditions: [{ column: "id", op: "is_null" }] }]
    });
    expect(parsed.combinator).toBe("AND");
    expect(parsed.groups[0].combinator).toBe("AND");
  });

  it("rejects empty groups", () => {
    expect(() => parseSearchQuery({ groups: [] })).toThrow(/at least one group/i);
  });

  it("rejects a group with no conditions", () => {
    expect(() => parseSearchQuery({ groups: [{ conditions: [] }] })).toThrow(/at least one condition/i);
  });

  it("rejects an invalid op", () => {
    expect(() =>
      parseSearchQuery({ groups: [{ conditions: [{ column: "id", op: "regex", value: "x" }] }] })
    ).toThrow(/op invalid/i);
  });

  it("requires value for value-ops", () => {
    expect(() =>
      parseSearchQuery({ groups: [{ conditions: [{ column: "id", op: "eq" }] }] })
    ).toThrow(/value required/i);
  });

  it("does not require value for is_null / is_not_null", () => {
    const parsed = parseSearchQuery({ groups: [{ conditions: [{ column: "id", op: "is_not_null" }] }] });
    expect(parsed.groups[0].conditions[0].value).toBeUndefined();
  });

  it("requires value2 for between", () => {
    expect(() =>
      parseSearchQuery({ groups: [{ conditions: [{ column: "age", op: "between", value: "1" }] }] })
    ).toThrow(/value2 required/i);
  });

  it("rejects too many groups", () => {
    const groups = Array.from({ length: 6 }, () => ({ conditions: [{ column: "id", op: "is_null" }] }));
    expect(() => parseSearchQuery({ groups })).toThrow(/Too many groups/i);
  });

  it("rejects too many total conditions", () => {
    const groups = Array.from({ length: 5 }, () => ({
      conditions: Array.from({ length: 10 }, () => ({ column: "id", op: "is_null" }))
    }));
    expect(() => parseSearchQuery({ groups })).toThrow(/Too many conditions total/i);
  });
});

describe("buildSearchWhere", () => {
  it("builds a simple equality", () => {
    const { sql, params } = buildSearchWhere(
      q([{ combinator: "AND", conditions: [{ column: "id", op: "eq", value: "5" }] }]),
      "mysql"
    );
    expect(sql).toBe("WHERE (`id` = ?)");
    expect(params).toEqual(["5"]);
  });

  it("ANDs conditions within a group and ORs groups", () => {
    const { sql, params } = buildSearchWhere(
      q(
        [
          { combinator: "AND", conditions: [
            { column: "a", op: "eq", value: "1" },
            { column: "b", op: "gt", value: "2" }
          ] },
          { combinator: "AND", conditions: [{ column: "c", op: "lt", value: "3" }] }
        ],
        "OR"
      ),
      "mysql"
    );
    expect(sql).toBe("WHERE (`a` = ? AND `b` > ?) OR (`c` < ?)");
    expect(params).toEqual(["1", "2", "3"]);
  });

  it("builds contains/starts_with/ends_with with correct wildcards", () => {
    const r1 = buildSearchWhere(q([{ combinator: "AND", conditions: [{ column: "n", op: "contains", value: "x" }] }]), "mysql");
    expect(r1.sql).toContain("`n` LIKE ?");
    expect(r1.params).toEqual(["%x%"]);

    const r2 = buildSearchWhere(q([{ combinator: "AND", conditions: [{ column: "n", op: "starts_with", value: "x" }] }]), "mysql");
    expect(r2.params).toEqual(["x%"]);

    const r3 = buildSearchWhere(q([{ combinator: "AND", conditions: [{ column: "n", op: "ends_with", value: "x" }] }]), "mysql");
    expect(r3.params).toEqual(["%x"]);
  });

  it("builds not_contains as NOT LIKE", () => {
    const r = buildSearchWhere(q([{ combinator: "AND", conditions: [{ column: "n", op: "not_contains", value: "x" }] }]), "mysql");
    expect(r.sql).toContain("`n` NOT LIKE ?");
    expect(r.params).toEqual(["%x%"]);
  });

  it("builds IN with one placeholder per item", () => {
    const r = buildSearchWhere(q([{ combinator: "AND", conditions: [{ column: "id", op: "in", value: "1, 2 ,3" }] }]), "mysql");
    expect(r.sql).toBe("WHERE (`id` IN (?, ?, ?))");
    expect(r.params).toEqual(["1", "2", "3"]);
  });

  it("builds BETWEEN with two params", () => {
    const r = buildSearchWhere(q([{ combinator: "AND", conditions: [{ column: "age", op: "between", value: "10", value2: "20" }] }]), "mysql");
    expect(r.sql).toBe("WHERE (`age` BETWEEN ? AND ?)");
    expect(r.params).toEqual(["10", "20"]);
  });

  it("builds IS NULL / IS NOT NULL without params", () => {
    const r = buildSearchWhere(
      q([{ combinator: "AND", conditions: [
        { column: "a", op: "is_null" },
        { column: "b", op: "is_not_null" }
      ] }]),
      "mysql"
    );
    expect(r.sql).toBe("WHERE (`a` IS NULL AND `b` IS NOT NULL)");
    expect(r.params).toEqual([]);
  });

  it("quotes identifiers per driver", () => {
    const pg = buildSearchWhere(q([{ combinator: "AND", conditions: [{ column: "id", op: "eq", value: "1" }] }]), "postgresql");
    expect(pg.sql).toBe('WHERE ("id" = ?)');
    const mssql = buildSearchWhere(q([{ combinator: "AND", conditions: [{ column: "id", op: "eq", value: "1" }] }]), "mssql");
    expect(mssql.sql).toBe("WHERE ([id] = ?)");
  });

  it("rejects an injection attempt in the column name", () => {
    expect(() =>
      buildSearchWhere(q([{ combinator: "AND", conditions: [{ column: "id; DROP TABLE x", op: "eq", value: "1" }] }]), "mysql")
    ).toThrow(/Invalid search column/i);
  });

  it("rejects empty IN list", () => {
    expect(() =>
      buildSearchWhere(q([{ combinator: "AND", conditions: [{ column: "id", op: "in", value: " , , " }] }]), "mysql")
    ).toThrow(/needs at least one value/i);
  });
});
