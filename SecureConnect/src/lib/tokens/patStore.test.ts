import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPat, verifyPat, listPats, revokePat, resetPats } from "./patStore";

const A = "alice@example.com";
const B = "bob@example.com";

describe("patStore (in-memory)", () => {
  beforeEach(() => resetPats());
  afterEach(() => vi.restoreAllMocks());

  it("creates a token with the dbm_pat_ prefix and never returns the hash", async () => {
    const { token, meta } = await createPat(A, "cli");
    expect(token.startsWith("dbm_pat_")).toBe(true);
    expect(token.length).toBeGreaterThan(40);
    expect(meta.label).toBe("cli");
    expect(meta.email).toBe(A);
    expect((meta as Record<string, unknown>).tokenHash).toBeUndefined();
  });

  it("verifies a valid token → owner email", async () => {
    const { token } = await createPat(A, "cli");
    const v = await verifyPat(token);
    expect(v?.email).toBe(A);
  });

  it("rejects garbage / wrong-prefix tokens", async () => {
    expect(await verifyPat("not-a-token")).toBeNull();
    expect(await verifyPat("dbm_pat_deadbeefwrong")).toBeNull();
    expect(await verifyPat("")).toBeNull();
  });

  it("rejects a revoked token", async () => {
    const { token, meta } = await createPat(A, "cli");
    expect(await verifyPat(token)).not.toBeNull();
    expect(await revokePat(meta.id, A)).toBe(true);
    expect(await verifyPat(token)).toBeNull();
  });

  it("only the owner can revoke", async () => {
    const { token, meta } = await createPat(A, "cli");
    expect(await revokePat(meta.id, B)).toBe(false);
    expect(await verifyPat(token)).not.toBeNull();
  });

  it("lists only the caller's tokens", async () => {
    await createPat(A, "a1");
    await createPat(A, "a2");
    await createPat(B, "b1");
    expect(await listPats(A)).toHaveLength(2);
    expect(await listPats(B)).toHaveLength(1);
  });

  it("updates lastUsedAt on verify", async () => {
    const { token, meta } = await createPat(A, "cli");
    expect(meta.lastUsedAt).toBeNull();
    await verifyPat(token);
    const after = (await listPats(A))[0];
    expect(after.lastUsedAt).not.toBeNull();
  });

  it("expires after its TTL", async () => {
    const spy = vi.spyOn(Date, "now");
    spy.mockReturnValue(1_000_000);
    const { token } = await createPat(A, "cli", 60); // +60s
    spy.mockReturnValue(1_000_000 + 61_000);
    expect(await verifyPat(token)).toBeNull();
  });

  it("supports no-expiry tokens", async () => {
    const { meta } = await createPat(A, "cli"); // no ttl
    expect(meta.expiresAt).toBeNull();
  });

  it("enforces the per-owner cap", async () => {
    for (let i = 0; i < 25; i++) await createPat(A, `t${i}`);
    await expect(createPat(A, "overflow")).rejects.toThrow(/Too many tokens/i);
  });
});
