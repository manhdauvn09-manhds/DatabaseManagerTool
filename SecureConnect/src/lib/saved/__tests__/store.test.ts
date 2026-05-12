import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProfiles, saveProfile, loadProfile, deleteProfile } from "../store";
import { _resetMasterKeyCache } from "@/lib/crypto/serverVault";

const MASTER = Buffer.alloc(32, 0x11).toString("base64");

let tmpDir: string;
let origPath: string | undefined;
let origMaster: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "dbm-saved-"));
  origPath = process.env.SAVED_CONNECTIONS_PATH;
  origMaster = process.env.VAULT_MASTER_SECRET;
  process.env.SAVED_CONNECTIONS_PATH = join(tmpDir, "saved.json");
  process.env.VAULT_MASTER_SECRET = MASTER;
  _resetMasterKeyCache();
});

afterEach(async () => {
  if (origPath === undefined) delete process.env.SAVED_CONNECTIONS_PATH;
  else process.env.SAVED_CONNECTIONS_PATH = origPath;
  if (origMaster === undefined) delete process.env.VAULT_MASTER_SECRET;
  else process.env.VAULT_MASTER_SECRET = origMaster;
  _resetMasterKeyCache();
  await rm(tmpDir, { recursive: true, force: true });
});

const PLAIN = JSON.stringify({ dbType: "mysql", host: "h", port: 3306, user: "u", password: "p" });

describe("saved/store (server-encrypted v2)", () => {
  test("save + load round-trip returns original plaintext", async () => {
    const meta = await saveProfile("a@x.com", "Prod MySQL", PLAIN);
    expect(meta.name).toBe("Prod MySQL");
    const loaded = await loadProfile("a@x.com", meta.id);
    expect(loaded?.plaintext).toBe(PLAIN);
  });

  test("on-disk file contains NO plaintext", async () => {
    await saveProfile("a@x.com", "X", PLAIN);
    const path = join(tmpDir, "saved.json");
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("password");
    expect(raw).not.toContain("3306");
    expect(raw).not.toContain("mysql"); // dbType value won't leak
    // Should contain encrypted fields and metadata, schema v2
    expect(raw).toContain('"version":2');
    expect(raw).toContain('"ciphertext"');
  });

  test("users are isolated (hashed-email key + per-user HKDF)", async () => {
    const m = await saveProfile("alice@x.com", "A", PLAIN);
    expect(await loadProfile("mallory@x.com", m.id)).toBeNull();
    const aliceList = await listProfiles("alice@x.com");
    expect(aliceList).toHaveLength(1);
    expect(await listProfiles("mallory@x.com")).toHaveLength(0);
  });

  test("delete removes only the targeted profile", async () => {
    const a = await saveProfile("u@x.com", "A", PLAIN);
    const b = await saveProfile("u@x.com", "B", PLAIN);
    expect(await deleteProfile("u@x.com", a.id)).toBe(true);
    const left = await listProfiles("u@x.com");
    expect(left.map((x) => x.id)).toEqual([b.id]);
  });

  test("delete cannot cross users", async () => {
    const m = await saveProfile("alice@x.com", "A", PLAIN);
    expect(await deleteProfile("mallory@x.com", m.id)).toBe(false);
    expect(await listProfiles("alice@x.com")).toHaveLength(1);
  });

  test("legacy v1 file is ignored", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(tmpDir, "saved.json"), JSON.stringify({ version: 1, users: { x: { profiles: [{ id: "old" }] } } }));
    const list = await listProfiles("a@x.com");
    expect(list).toHaveLength(0);
    // Subsequent save should overwrite with v2 schema.
    await saveProfile("a@x.com", "Fresh", PLAIN);
    const raw = await readFile(join(tmpDir, "saved.json"), "utf8");
    expect(raw).toContain('"version":2');
  });
});
