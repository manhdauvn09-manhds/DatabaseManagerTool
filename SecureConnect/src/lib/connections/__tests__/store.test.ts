import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createConnectionRecord,
  getConnectionRecord,
  deleteConnectionRecord,
  cleanupExpired,
  type ConnectionRecord
} from "../store";

type CreateInput = Omit<ConnectionRecord, "id" | "createdAt" | "expiresAt">;

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

// REDIS_URL unset in tests → in-memory backend. Functions are async; await all.
describe("connections store (in-memory)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("create + get by matching owner", async () => {
    const rec = await createConnectionRecord(makeInput());
    const got = await getConnectionRecord(rec.id, "alice@example.com");
    expect(got?.id).toBe(rec.id);
    expect(got?.dbType).toBe("mysql");
    await deleteConnectionRecord(rec.id);
  });

  test("get with wrong owner returns null", async () => {
    const rec = await createConnectionRecord(makeInput());
    expect(await getConnectionRecord(rec.id, "mallory@evil.com")).toBeNull();
    await deleteConnectionRecord(rec.id);
  });

  test("get for unknown id returns null", async () => {
    expect(await getConnectionRecord("00000000-0000-0000-0000-000000000000", "alice@example.com")).toBeNull();
  });

  test("TTL: get returns null after expiry and clears the record", async () => {
    const rec = await createConnectionRecord(makeInput());
    vi.advanceTimersByTime(31 * 60_000); // > default 30-min TTL
    expect(await getConnectionRecord(rec.id, "alice@example.com")).toBeNull();
    expect(await getConnectionRecord(rec.id, "alice@example.com")).toBeNull();
  });

  test("cleanupExpired removes only expired records", async () => {
    const a = await createConnectionRecord(makeInput({ ownerEmail: "a@x.com" }));
    vi.advanceTimersByTime(31 * 60_000);
    const b = await createConnectionRecord(makeInput({ ownerEmail: "b@x.com" }));
    await cleanupExpired();
    expect(await getConnectionRecord(a.id, "a@x.com")).toBeNull();
    expect((await getConnectionRecord(b.id, "b@x.com"))?.id).toBe(b.id);
    await deleteConnectionRecord(b.id);
  });

  test("delete removes the record", async () => {
    const rec = await createConnectionRecord(makeInput());
    await deleteConnectionRecord(rec.id);
    expect(await getConnectionRecord(rec.id, "alice@example.com")).toBeNull();
  });

  test("multiple owners are isolated", async () => {
    const a = await createConnectionRecord(makeInput({ ownerEmail: "a@x.com" }));
    const b = await createConnectionRecord(makeInput({ ownerEmail: "b@x.com" }));
    expect(await getConnectionRecord(a.id, "b@x.com")).toBeNull();
    expect(await getConnectionRecord(b.id, "a@x.com")).toBeNull();
    expect((await getConnectionRecord(a.id, "a@x.com"))?.id).toBe(a.id);
    expect((await getConnectionRecord(b.id, "b@x.com"))?.id).toBe(b.id);
    await deleteConnectionRecord(a.id);
    await deleteConnectionRecord(b.id);
  });

  test("get bumps expiresAt forward (sliding TTL)", async () => {
    const rec = await createConnectionRecord(makeInput());
    const initialExpiry = rec.expiresAt;
    vi.advanceTimersByTime(60_000);
    const got = await getConnectionRecord(rec.id, "alice@example.com");
    expect(got).not.toBeNull();
    expect(got!.expiresAt).toBeGreaterThan(initialExpiry);
    await deleteConnectionRecord(rec.id);
  });

  test("sliding TTL is capped by MAX_SESSION_MS (2h default)", async () => {
    const rec = await createConnectionRecord(makeInput());
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(20 * 60_000);
      const got = await getConnectionRecord(rec.id, "alice@example.com");
      expect(got).not.toBeNull();
      const maxSessionEnd = rec.createdAt + 2 * 60 * 60_000;
      expect(got!.expiresAt).toBeLessThanOrEqual(maxSessionEnd);
    }
    await deleteConnectionRecord(rec.id);
  });
});
