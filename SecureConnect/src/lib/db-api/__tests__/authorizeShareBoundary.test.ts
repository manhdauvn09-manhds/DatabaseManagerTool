/**
 * V-04 regression: a read-only share link must never reach a write.
 *
 * Before this, `ctx.readonly` was computed in authorize() and read by nobody —
 * the share boundary rested entirely on developers remembering not to pass
 * `allowShare` to a write handler. V-01 showed that convention had already
 * failed once (db.query executes arbitrary SQL and had allowShare: true).
 * These tests pin the enforced behaviour so it cannot regress silently.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const OWNER = "owner@example.com";
const GUEST = "guest@example.com";
const CONN_ID = "11111111-2222-4333-8444-555555555555";
const SHARE_TOKEN = "share-token-abc";

const REC = { id: CONN_ID, host: "db.example.com", port: 5432, dbType: "postgresql" };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => ({ user: { email: GUEST } }))
}));
vi.mock("@/lib/security/rateLimit", () => ({
  getClientIp: () => "203.0.113.9",
  rateLimit: vi.fn(async () => ({ ok: true, remaining: 59 }))
}));
vi.mock("@/lib/security/auditLog", () => ({ audit: vi.fn() }));
vi.mock("@/lib/tokens/patStore", () => ({ verifyPat: vi.fn(async () => null) }));
vi.mock("@/lib/sharing/shareStore", () => ({
  getShare: vi.fn(async (t: string) =>
    t === SHARE_TOKEN ? { token: t, connectionId: CONN_ID, ownerEmail: OWNER } : null
  )
}));
vi.mock("@/lib/connections/store", () => ({
  // Owner-scoped lookup: only the owner's email resolves the record.
  getConnectionRecord: vi.fn(async (id: string, email: string) =>
    id === CONN_ID && email === OWNER ? REC : null
  )
}));

import { authorize } from "../route-helper";

const ORIGIN = "https://dbmanager.example.com";

function req(headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/db/${CONN_ID}/rows`, {
    method: "POST",
    headers: { origin: ORIGIN, ...headers }
  });
}

beforeEach(() => {
  process.env.AUTH_URL = ORIGIN;
});

describe("authorize() — share is read-only", () => {
  it("grants a share holder read access when the route opts in", async () => {
    const r = await authorize(req({ "x-share-token": SHARE_TOKEN }), CONN_ID, "db.rows", {
      allowShare: true
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ctx.readonly).toBe(true);
      expect(r.ctx.rec).toEqual(REC);
    }
  });

  it("refuses a share holder on a mutation route (403), not 404", async () => {
    const r = await authorize(req({ "x-share-token": SHARE_TOKEN }), CONN_ID, "db.rows.insert", {
      mutation: true
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });

  it("rejects a route declaring both allowShare and mutation as a config error", async () => {
    const r = await authorize(req({ "x-share-token": SHARE_TOKEN }), CONN_ID, "db.bogus", {
      allowShare: true,
      mutation: true
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });

  it("never returns a readonly context to a mutation route", async () => {
    // The property that actually matters, stated directly: whatever the opts,
    // ok===true plus mutation must imply readonly===false.
    for (const opts of [{ mutation: true }, { mutation: true, allowShare: true }]) {
      const r = await authorize(req({ "x-share-token": SHARE_TOKEN }), CONN_ID, "db.rows.delete", opts);
      if (r.ok) expect(r.ctx.readonly).toBe(false);
    }
  });

  it("still refuses a non-owner who has no share token at all", async () => {
    const r = await authorize(req(), CONN_ID, "db.rows", { allowShare: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(404); // record not found for guest
  });
});
