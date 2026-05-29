import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { encryptForUser, decryptForUser, isVaultConfigured, _resetMasterKeyCache } from "../serverVault";

const MASTER_OK = Buffer.alloc(32, 7).toString("base64");

let original: string | undefined;
let originalOld: string | undefined;
beforeEach(() => {
  original = process.env.VAULT_MASTER_SECRET;
  originalOld = process.env.VAULT_MASTER_SECRET_OLD;
  process.env.VAULT_MASTER_SECRET = MASTER_OK;
  delete process.env.VAULT_MASTER_SECRET_OLD;
  _resetMasterKeyCache();
});
afterEach(() => {
  if (original === undefined) delete process.env.VAULT_MASTER_SECRET;
  else process.env.VAULT_MASTER_SECRET = original;
  if (originalOld === undefined) delete process.env.VAULT_MASTER_SECRET_OLD;
  else process.env.VAULT_MASTER_SECRET_OLD = originalOld;
  _resetMasterKeyCache();
});

describe("serverVault", () => {
  test("round-trip encrypt/decrypt", () => {
    const blob = encryptForUser("a@x.com", "hello world");
    const back = decryptForUser("a@x.com", blob);
    expect(back).toBe("hello world");
  });

  test("different users cannot decrypt each other's data", () => {
    const blob = encryptForUser("a@x.com", "secret-A");
    expect(() => decryptForUser("b@x.com", blob)).toThrow();
  });

  test("email comparison is case-insensitive (lowercased)", () => {
    const blob = encryptForUser("Alice@X.com", "x");
    expect(decryptForUser("alice@x.com", blob)).toBe("x");
  });

  test("ciphertext varies per call (random salt + iv)", () => {
    const a = encryptForUser("u@x.com", "same");
    const b = encryptForUser("u@x.com", "same");
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(decryptForUser("u@x.com", a)).toBe("same");
    expect(decryptForUser("u@x.com", b)).toBe("same");
  });

  test("isVaultConfigured returns true when env set", () => {
    expect(isVaultConfigured()).toBe(true);
  });

  test("throws when VAULT_MASTER_SECRET missing", () => {
    delete process.env.VAULT_MASTER_SECRET;
    _resetMasterKeyCache();
    expect(isVaultConfigured()).toBe(false);
    expect(() => encryptForUser("a@x.com", "x")).toThrow(/VAULT_MASTER_SECRET/);
  });

  test("throws when VAULT_MASTER_SECRET too short", () => {
    process.env.VAULT_MASTER_SECRET = Buffer.alloc(16).toString("base64"); // only 16 bytes
    _resetMasterKeyCache();
    expect(() => encryptForUser("a@x.com", "x")).toThrow(/need ≥ 32/);
  });

  test("rejects tampered ciphertext (auth tag fail)", () => {
    const blob = encryptForUser("a@x.com", "x");
    const tampered = { ...blob, ciphertext: Buffer.from(blob.ciphertext, "base64").reverse().toString("base64") };
    expect(() => decryptForUser("a@x.com", tampered)).toThrow();
  });

  test("blob carries key fingerprint v", () => {
    const blob = encryptForUser("a@x.com", "x");
    expect(blob.v).toMatch(/^[0-9a-f]{8}$/);
  });

  test("key rotation: old-key data still decrypts via VAULT_MASTER_SECRET_OLD", () => {
    // Encrypt with key A.
    const KEY_A = MASTER_OK;
    process.env.VAULT_MASTER_SECRET = KEY_A;
    _resetMasterKeyCache();
    const blob = encryptForUser("u@x.com", "old-secret");

    // Rotate: new primary B, old A as fallback.
    const KEY_B = Buffer.alloc(32, 0xbb).toString("base64");
    process.env.VAULT_MASTER_SECRET = KEY_B;
    process.env.VAULT_MASTER_SECRET_OLD = KEY_A;
    _resetMasterKeyCache();

    // Old blob still decrypts (via OLD); new encryption uses B.
    expect(decryptForUser("u@x.com", blob)).toBe("old-secret");
    const fresh = encryptForUser("u@x.com", "new-secret");
    expect(fresh.v).not.toBe(blob.v);
    expect(decryptForUser("u@x.com", fresh)).toBe("new-secret");
  });

  test("after rotation without OLD, old data is unreadable", () => {
    process.env.VAULT_MASTER_SECRET = MASTER_OK;
    _resetMasterKeyCache();
    const blob = encryptForUser("u@x.com", "secret");
    process.env.VAULT_MASTER_SECRET = Buffer.alloc(32, 0xcc).toString("base64");
    delete process.env.VAULT_MASTER_SECRET_OLD;
    _resetMasterKeyCache();
    expect(() => decryptForUser("u@x.com", blob)).toThrow();
  });
});
