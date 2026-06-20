import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createShare, getShare, revokeShare, listShares, resetShares } from "./shareStore";

const A = "alice@example.com";
const B = "bob@example.com";
const CONN = "11111111-1111-1111-1111-111111111111";

describe("shareStore (in-memory)", () => {
  beforeEach(() => {
    resetShares();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a share with a high-entropy token", async () => {
    const s = await createShare(CONN, A, 3600);
    expect(s.token).toBeTruthy();
    expect(s.token.length).toBeGreaterThanOrEqual(40); // base64url of 32 bytes ≈ 43 chars
    expect(s.connectionId).toBe(CONN);
    expect(s.ownerEmail).toBe(A);
    expect(s.expiresAt).toBeGreaterThan(s.createdAt);
  });

  it("resolves a valid token", async () => {
    const s = await createShare(CONN, A);
    const got = await getShare(s.token);
    expect(got?.connectionId).toBe(CONN);
    expect(got?.ownerEmail).toBe(A);
  });

  it("returns null for an unknown token", async () => {
    expect(await getShare("nope-not-a-real-token-xxxxxxxxxxxxx")).toBeNull();
  });

  it("returns null for malformed tokens", async () => {
    expect(await getShare("")).toBeNull();
    expect(await getShare("short")).toBeNull();
  });

  it("clamps TTL to the max (24h)", async () => {
    const s = await createShare(CONN, A, 9_999_999); // way over 24h
    const ttl = s.expiresAt - s.createdAt;
    expect(ttl).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it("clamps TTL to the min (1m)", async () => {
    const s = await createShare(CONN, A, 1); // under 1m
    const ttl = s.expiresAt - s.createdAt;
    expect(ttl).toBeGreaterThanOrEqual(60 * 1000);
  });

  it("expires after its TTL", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000_000);
    const s = await createShare(CONN, A, 60); // +60s
    nowSpy.mockReturnValue(1_000_000 + 61_000);
    expect(await getShare(s.token)).toBeNull();
  });

  it("only the owner can revoke", async () => {
    const s = await createShare(CONN, A);
    expect(await revokeShare(s.token, B)).toBe(false); // not owner
    expect(await getShare(s.token)).not.toBeNull();    // still alive
    expect(await revokeShare(s.token, A)).toBe(true);  // owner
    expect(await getShare(s.token)).toBeNull();         // gone
  });

  it("lists only the caller's shares", async () => {
    await createShare(CONN, A);
    await createShare(CONN, A);
    await createShare(CONN, B);
    const aShares = await listShares(A);
    const bShares = await listShares(B);
    expect(aShares).toHaveLength(2);
    expect(bShares).toHaveLength(1);
    expect(aShares.every((s) => s.ownerEmail === A)).toBe(true);
  });

  it("enforces the per-owner cap", async () => {
    for (let i = 0; i < 50; i++) await createShare(CONN, A);
    await expect(createShare(CONN, A)).rejects.toThrow(/Too many active shares/i);
  });
});
