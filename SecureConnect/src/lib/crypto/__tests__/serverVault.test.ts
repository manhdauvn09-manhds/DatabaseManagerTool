import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { encryptForUser, decryptForUser, isVaultConfigured, _resetMasterKeyCache } from "../serverVault";

const MASTER_OK = Buffer.alloc(32, 7).toString("base64");

let original: string | undefined;
beforeEach(() => {
  original = process.env.VAULT_MASTER_SECRET;
  process.env.VAULT_MASTER_SECRET = MASTER_OK;
  _resetMasterKeyCache();
});
afterEach(() => {
  if (original === undefined) delete process.env.VAULT_MASTER_SECRET;
  else process.env.VAULT_MASTER_SECRET = original;
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
});
