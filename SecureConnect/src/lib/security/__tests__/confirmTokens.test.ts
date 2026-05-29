import { describe, test, expect, beforeEach } from "vitest";
import { issueToken, consumeToken, resetTokens } from "../confirmTokens";

// REDIS_URL unset → in-memory backend. Functions are async; await all.
describe("confirmTokens (in-memory)", () => {
  beforeEach(() => resetTokens());

  test("issued token matches its payload", async () => {
    const payload = { action: "delete", table: "users", where: { id: 1 } };
    const t = await issueToken(payload);
    expect(t).toMatch(/^[A-Z0-9]{8}$/);
    const r = await consumeToken(t, payload);
    expect(r.ok).toBe(true);
  });

  test("token is single-use", async () => {
    const p = { action: "update", table: "x", where: { id: 1 }, set: { a: 1 } };
    const t = await issueToken(p);
    expect((await consumeToken(t, p)).ok).toBe(true);
    expect((await consumeToken(t, p)).ok).toBe(false);
  });

  test("payload mismatch is rejected", async () => {
    const p1 = { action: "delete", table: "users", where: { id: 1 } };
    const p2 = { action: "delete", table: "users", where: { id: 2 } };
    const t = await issueToken(p1);
    const r = await consumeToken(t, p2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("mismatch");
  });

  test("unknown token rejected", async () => {
    const r = await consumeToken("AAAAAAAA", { foo: "bar" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing");
  });

  test("malformed token rejected", async () => {
    expect((await consumeToken("", {})).ok).toBe(false);
    expect((await consumeToken("abc", {})).ok).toBe(false);
    expect((await consumeToken("12345678", {})).ok).toBe(false);
    expect((await consumeToken("XXXXX", {})).ok).toBe(false);
  });
});
