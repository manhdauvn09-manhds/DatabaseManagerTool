import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createConnectionRecord,
  getConnectionRecord,
  deleteConnectionRecord,
  cleanupExpired
} from "../store";

type CreateInput = Parameters<typeof createConnectionRecord>[0];

function makeInput(overrides: Partial<CreateInput> = {}): CreateInput {
  return {
    ownerEmail: "alice@example.com",
    dbType: "mysql",
    host: "db.example.com",
    port: 3306,
    user: "root",
    password: "secret",
    ...overrides
  };
}

describe("connections store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("create + get by matching owner", () => {
    const rec = createConnectionRecord(makeInput());
    const got = getConnectionRecord(rec.id, "alice@example.com");
    expect(got?.id).toBe(rec.id);
    expect(got?.dbType).toBe("mysql");
    deleteConnectionRecord(rec.id);
  });

  test("get with wrong owner returns null", () => {
    const rec = createConnectionRecord(makeInput());
    expect(getConnectionRecord(rec.id, "mallory@evil.com")).toBeNull();
    deleteConnectionRecord(rec.id);
  });

  test("get for unknown id returns null", () => {
    expect(getConnectionRecord("00000000-0000-0000-0000-000000000000", "alice@example.com")).toBeNull();
  });

  test("TTL: get returns null after expiry and clears the record", () => {
    const rec = createConnectionRecord(makeInput());
    vi.advanceTimersByTime(31 * 60_000); // > default 30-min TTL
    expect(getConnectionRecord(rec.id, "alice@example.com")).toBeNull();
    // Re-get is also null (record was deleted by the first call).
    expect(getConnectionRecord(rec.id, "alice@example.com")).toBeNull();
  });

  test("cleanupExpired removes only expired records", () => {
    const a = createConnectionRecord(makeInput({ ownerEmail: "a@x.com" }));
    vi.advanceTimersByTime(31 * 60_000); // > 30-min TTL
    const b = createConnectionRecord(makeInput({ ownerEmail: "b@x.com" }));
    cleanupExpired();
    expect(getConnectionRecord(a.id, "a@x.com")).toBeNull();
    expect(getConnectionRecord(b.id, "b@x.com")?.id).toBe(b.id);
    deleteConnectionRecord(b.id);
  });

  test("delete removes the record", () => {
    const rec = createConnectionRecord(makeInput());
    deleteConnectionRecord(rec.id);
    expect(getConnectionRecord(rec.id, "alice@example.com")).toBeNull();
  });

  test("multiple owners are isolated", () => {
    const a = createConnectionRecord(makeInput({ ownerEmail: "a@x.com" }));
    const b = createConnectionRecord(makeInput({ ownerEmail: "b@x.com" }));
    expect(getConnectionRecord(a.id, "b@x.com")).toBeNull();
    expect(getConnectionRecord(b.id, "a@x.com")).toBeNull();
    expect(getConnectionRecord(a.id, "a@x.com")?.id).toBe(a.id);
    expect(getConnectionRecord(b.id, "b@x.com")?.id).toBe(b.id);
    deleteConnectionRecord(a.id);
    deleteConnectionRecord(b.id);
  });

  test("get bumps expiresAt forward (sliding TTL)", () => {
    const rec = createConnectionRecord(makeInput());
    const initialExpiry = rec.expiresAt;
    vi.advanceTimersByTime(60_000);
    const got = getConnectionRecord(rec.id, "alice@example.com");
    expect(got).not.toBeNull();
    expect(got!.expiresAt).toBeGreaterThan(initialExpiry);
    deleteConnectionRecord(rec.id);
  });

  test("sliding TTL is capped by MAX_SESSION_MS (2h default)", () => {
    const rec = createConnectionRecord(makeInput());
    // Slide multiple times to stay alive past initial 30m TTL, then verify cap.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(20 * 60_000); // 20m steps → total 80m, then 100m, 120m
      const got = getConnectionRecord(rec.id, "alice@example.com");
      expect(got).not.toBeNull();
      const maxSessionEnd = rec.createdAt + 2 * 60 * 60_000;
      expect(got!.expiresAt).toBeLessThanOrEqual(maxSessionEnd);
    }
    deleteConnectionRecord(rec.id);
  });
});
