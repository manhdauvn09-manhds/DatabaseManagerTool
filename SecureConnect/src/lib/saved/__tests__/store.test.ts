import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProfiles, saveProfile, deleteProfile } from "../store";

let tmpDir: string;
let originalPath: string | undefined;

function makeProfile(name: string) {
  return {
    name,
    salt: "A".repeat(22) + "==",
    iv: "A".repeat(14) + "==",
    ciphertext: "AAAAAAAA",
    kdf: { name: "PBKDF2" as const, hash: "SHA-256" as const, iterations: 200_000 }
  };
}

describe("saved/store", () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dbm-saved-test-"));
    originalPath = process.env.SAVED_CONNECTIONS_PATH;
    process.env.SAVED_CONNECTIONS_PATH = join(tmpDir, "saved.json");
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env.SAVED_CONNECTIONS_PATH;
    else process.env.SAVED_CONNECTIONS_PATH = originalPath;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("save + list round-trip", async () => {
    const saved = await saveProfile("a@x.com", makeProfile("Prod MySQL"));
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.name).toBe("Prod MySQL");
    const list = await listProfiles("a@x.com");
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(saved.id);
  });

  test("users are isolated (hashed email key)", async () => {
    await saveProfile("alice@x.com", makeProfile("A"));
    await saveProfile("bob@x.com", makeProfile("B"));
    const alice = await listProfiles("alice@x.com");
    const bob = await listProfiles("bob@x.com");
    expect(alice).toHaveLength(1);
    expect(bob).toHaveLength(1);
    expect(alice[0].name).toBe("A");
    expect(bob[0].name).toBe("B");
  });

  test("delete removes only the targeted profile", async () => {
    const a = await saveProfile("u@x.com", makeProfile("A"));
    const b = await saveProfile("u@x.com", makeProfile("B"));
    expect(await deleteProfile("u@x.com", a.id)).toBe(true);
    const left = await listProfiles("u@x.com");
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe(b.id);
  });

  test("delete non-existent returns false", async () => {
    const r = await deleteProfile("u@x.com", "00000000-0000-0000-0000-000000000000");
    expect(r).toBe(false);
  });

  test("delete cannot cross users", async () => {
    const a = await saveProfile("alice@x.com", makeProfile("A"));
    const r = await deleteProfile("mallory@x.com", a.id);
    expect(r).toBe(false);
    expect(await listProfiles("alice@x.com")).toHaveLength(1);
  });

  test("email is case-insensitive (lowercased before hashing)", async () => {
    await saveProfile("Alice@X.com", makeProfile("A"));
    const list = await listProfiles("alice@x.com");
    expect(list).toHaveLength(1);
  });
});
