import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  encryptForUser,
  decryptForUser,
  isVaultConfigured,
  _resetMasterKeyCache,
  type ServerVaultBlob
} from "../serverVault";

function generateTestKey(): string {
  return randomBytes(32).toString("base64");
}

describe("serverVault (AES-256-GCM encryption)", () => {
  beforeEach(() => {
    process.env.VAULT_MASTER_SECRET = generateTestKey();
    delete process.env.VAULT_MASTER_SECRET_OLD;
    _resetMasterKeyCache();
  });

  afterEach(() => {
    delete process.env.VAULT_MASTER_SECRET;
    delete process.env.VAULT_MASTER_SECRET_OLD;
    _resetMasterKeyCache();
  });

  test("isVaultConfigured() returns true when VAULT_MASTER_SECRET is set", () => {
    expect(isVaultConfigured()).toBe(true);
  });

  test("isVaultConfigured() returns false when VAULT_MASTER_SECRET is missing", () => {
    delete process.env.VAULT_MASTER_SECRET;
    _resetMasterKeyCache();
    expect(isVaultConfigured()).toBe(false);
  });

  test("encryptForUser + decryptForUser roundtrip", () => {
    const email = "alice@example.com";
    const plaintext = "my-secret-password-123";
    const blob = encryptForUser(email, plaintext);
    const decrypted = decryptForUser(email, blob);
    expect(decrypted).toBe(plaintext);
  });

  test("encryptForUser includes version fingerprint", () => {
    const blob = encryptForUser("test@example.com", "secret");
    expect(blob.v).toBeDefined();
    expect(blob.v?.length).toBe(8);
  });

  test("decryptForUser rejects wrong email", () => {
    const blob = encryptForUser("alice@example.com", "secret-data");
    expect(() => decryptForUser("bob@example.com", blob)).toThrow();
  });

  test("decryptForUser handles key rotation (old key fallback)", () => {
    const email = "charlie@example.com";
    const plaintext = "rotation-test";
    const blobV1 = encryptForUser(email, plaintext);

    const newKey = generateTestKey();
    const oldKey = process.env.VAULT_MASTER_SECRET;
    process.env.VAULT_MASTER_SECRET_OLD = oldKey;
    process.env.VAULT_MASTER_SECRET = newKey;
    _resetMasterKeyCache();

    const decrypted = decryptForUser(email, blobV1);
    expect(decrypted).toBe(plaintext);
  });

  test("encryptForUser generates unique salts per call", () => {
    const blob1 = encryptForUser("diana@example.com", "test");
    const blob2 = encryptForUser("diana@example.com", "test");
    expect(blob1.salt).not.toBe(blob2.salt);
    expect(blob1.ciphertext).not.toBe(blob2.ciphertext);
  });

  test("decryptForUser rejects tampered ciphertext", () => {
    const blob = encryptForUser("frank@example.com", "test");
    const tampered = Buffer.from(blob.ciphertext, "base64");
    tampered[0] ^= 0xff;

    expect(() => decryptForUser("frank@example.com", {
      salt: blob.salt,
      iv: blob.iv,
      ciphertext: tampered.toString("base64"),
      v: blob.v
    })).toThrow();
  });
});
