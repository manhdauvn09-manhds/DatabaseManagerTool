/**
 * Server-side at-rest encryption for saved connection profiles.
 *
 * Algorithm: HKDF-SHA-256(master, salt, info=email-hash) → 256-bit AES-GCM key.
 * Per-profile random salt (16 bytes) + IV (12 bytes). Auth tag appended to ciphertext.
 *
 * Threat model covered:
 *   - File-only leak of /data/saved-connections.json: SAFE (no master key in file).
 *   - .env leak alone: SAFE (no ciphertext).
 *   - Both stolen / full root compromise: NOT covered (operator-level access).
 *
 * The master secret MUST be configured via VAULT_MASTER_SECRET env (≥32 bytes base64).
 */
import { hkdfSync, randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";

const KEY_LEN = 32;            // AES-256
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedMaster: Buffer | null = null;

export function isVaultConfigured(): boolean {
  try { masterKey(); return true; } catch { return false; }
}

function masterKey(): Buffer {
  if (cachedMaster) return cachedMaster;
  const s = process.env.VAULT_MASTER_SECRET;
  if (!s) throw new Error("VAULT_MASTER_SECRET not configured");
  const b = Buffer.from(s.trim(), "base64");
  if (b.length < KEY_LEN) throw new Error(`VAULT_MASTER_SECRET decodes to ${b.length} bytes; need ≥ ${KEY_LEN}`);
  cachedMaster = b;
  return b;
}

// Visible for tests: lets the test setup pick up a new env value after override.
export function _resetMasterKeyCache(): void { cachedMaster = null; }

function deriveKey(email: string, salt: Buffer): Buffer {
  const ikm = masterKey();
  const emailHash = createHash("sha256").update(email.toLowerCase().trim()).digest();
  const info = Buffer.concat([Buffer.from("dbmanager:saved:v2:"), emailHash]);
  const out = hkdfSync("sha256", ikm, salt, info, KEY_LEN);
  return Buffer.from(out);
}

export type ServerVaultBlob = { salt: string; iv: string; ciphertext: string };

export function encryptForUser(email: string, plaintext: string): ServerVaultBlob {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(email, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    ciphertext: Buffer.concat([enc, tag]).toString("base64")
  };
}

export function decryptForUser(email: string, blob: ServerVaultBlob): string {
  const salt = Buffer.from(blob.salt, "base64");
  const iv = Buffer.from(blob.iv, "base64");
  const ctTag = Buffer.from(blob.ciphertext, "base64");
  if (salt.length !== SALT_LEN || iv.length !== IV_LEN || ctTag.length < TAG_LEN + 1) {
    throw new Error("Malformed vault blob");
  }
  const tag = ctTag.subarray(ctTag.length - TAG_LEN);
  const enc = ctTag.subarray(0, ctTag.length - TAG_LEN);
  const key = deriveKey(email, salt);
  const dec = createDecipheriv("aes-256-gcm", key, iv);
  dec.setAuthTag(tag);
  // Throws OperationError if tag fails — caller maps to user-facing error.
  return Buffer.concat([dec.update(enc), dec.final()]).toString("utf8");
}
