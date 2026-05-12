import { describe, test, expect, beforeEach } from "vitest";
import { issueToken, consumeToken, resetTokens } from "../confirmTokens";

describe("confirmTokens", () => {
  beforeEach(() => resetTokens());

  test("issued token matches its payload", () => {
    const payload = { action: "delete", table: "users", where: { id: 1 } };
    const t = issueToken(payload);
    expect(t).toMatch(/^[A-Z0-9]{8}$/);
    const r = consumeToken(t, payload);
    expect(r.ok).toBe(true);
  });

  test("token is single-use", () => {
    const p = { action: "update", table: "x", where: { id: 1 }, set: { a: 1 } };
    const t = issueToken(p);
    expect(consumeToken(t, p).ok).toBe(true);
    expect(consumeToken(t, p).ok).toBe(false);
  });

  test("payload mismatch is rejected", () => {
    const p1 = { action: "delete", table: "users", where: { id: 1 } };
    const p2 = { action: "delete", table: "users", where: { id: 2 } };
    const t = issueToken(p1);
    const r = consumeToken(t, p2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("mismatch");
  });

  test("unknown token rejected", () => {
    const r = consumeToken("AAAAAAAA", { foo: "bar" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing");
  });

  test("malformed token rejected", () => {
    expect(consumeToken("", {}).ok).toBe(false);
    expect(consumeToken("abc", {}).ok).toBe(false);
    expect(consumeToken("12345678", {}).ok).toBe(false);  // digit-only is OK by regex but not in store
    expect(consumeToken("XXXXX", {}).ok).toBe(false);
  });
});
