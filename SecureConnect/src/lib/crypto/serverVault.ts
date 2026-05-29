/**
 * Server-side at-rest encryption for saved connection profiles.
 *
 * Algorithm: HKDF-SHA-256(master, salt, info=email-hash) → 256-bit AES-GCM key.
 * Per-profile random salt (16 bytes) + IV (12 bytes). Auth tag appended to ciphertext.
 *
 * Key rotation (NEW):
 *   - Primary master from VAULT_MASTER_SECRET (used for ALL new encryption).
 *   - Optional VAULT_MASTER_SECRET_OLD — decrypt-only fallback for data encrypted
 *     before a rotation. Each blob carries `v` = short fingerprint of the key that
 *     encrypted it, so decrypt picks the right master (and old blobs without `v`
 *     are tried against every known key).
 *   - Rotation procedure: set VAULT_MASTER_SECRET_OLD = current secret, set a fresh
 *     VAULT_MASTER_SECRET, redeploy. Old profiles still decrypt; re-saving migrates
 *     them to the new key. Once all migrated, drop VAULT_MASTER_SECRET_OLD.
 *
 * Threat model: file-only leak SAFE (no key in file); .env leak alone SAFE (no
 * ciphertext); both / full root = operator-level.
 */
import { hkdfSync, randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";

const KEY_LEN = 32;            // AES-256
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

type MasterKey = { id: string; secret: Buffer };
let cachedKeys: MasterKey[] | null = null;

function parseMaster(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const b = Buffer.from(raw.trim(), "base64");
  if (b.length < KEY_LEN) throw new Error(`VAULT master secret decodes to ${b.length} bytes; need ≥ ${KEY_LEN}`);
  return b;
}

function fingerprint(secret: Buffer): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 8);
}

// Ordered: primary first (used for encryption), then old (decrypt-only).
function masterKeys(): MasterKey[] {
  if (cachedKeys) return cachedKeys;
  const primary = parseMaster(process.env.VAULT_MASTER_SECRET);
  if (!primary) throw new Error("VAULT_MASTER_SECRET not configured");
  const keys: MasterKey[] = [{ id: fingerprint(primary), secret: primary }];
  const old = parseMaster(process.env.VAULT_MASTER_SECRET_OLD);
  if (old && fingerprint(old) !== keys[0].id) keys.push({ id: fingerprint(old), secret: old });
  cachedKeys = keys;
  return keys;
}

export function isVaultConfigured(): boolean {
  try { masterKeys(); return true; } catch { return false; }
}

// Visible for tests: lets the test setup pick up new env values after override.
export function _resetMasterKeyCache(): void { cachedKeys = null; }

function deriveKey(email: string, salt: Buffer, master: Buffer): Buffer {
  const emailHash = createHash("sha256").update(email.toLowerCase().trim()).digest();
  const info = Buffer.concat([Buffer.from("dbmanager:saved:v2:"), emailHash]);
  const out = hkdfSync("sha256", master, salt, info, KEY_LEN);
  return Buffer.from(out);
}

export type ServerVaultBlob = { salt: string; iv: string; ciphertext: string; v?: string };

export function encryptForUser(email: string, plaintext: string): ServerVaultBlob {
  const primary = masterKeys()[0];
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(email, salt, primary.secret);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    ciphertext: Buffer.concat([enc, tag]).toString("base64"),
    v: primary.id
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

  const keys = masterKeys();
  // Prefer the key whose fingerprint matches blob.v; otherwise try all (legacy blobs).
  const ordered = blob.v ? [...keys].sort((a) => (a.id === blob.v ? -1 : 1)) : keys;

  let lastErr: unknown;
  for (const k of ordered) {
    try {
      const key = deriveKey(email, salt, k.secret);
      const dec = createDecipheriv("aes-256-gcm", key, iv);
      dec.setAuthTag(tag);
      return Buffer.concat([dec.update(enc), dec.final()]).toString("utf8");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Decrypt failed");
}
