/**
 * Client-side vault — encrypt/decrypt small JSON blobs with a passphrase.
 *
 * Algorithm:
 *   - PBKDF2-SHA-256, 200k iterations, 16-byte random salt → 256-bit AES-GCM key
 *   - AES-GCM with 12-byte random IV
 *   - Output: base64-encoded { salt, iv, ciphertext, kdf{name,hash,iterations} }
 *
 * The passphrase NEVER leaves the browser. Server only sees the ciphertext.
 *
 * Works in browser + node (>=20) via global `crypto.subtle`.
 */

export const VAULT_KDF = { name: "PBKDF2", hash: "SHA-256", iterations: 200_000 } as const;

export type VaultBlob = {
  salt: string;
  iv: string;
  ciphertext: string;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number };
};

function bufToB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64ToBuf(s: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64"));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptPayload(passphrase: string, payload: unknown): Promise<VaultBlob> {
  if (!passphrase || passphrase.length < 8) throw new Error("Passphrase must be at least 8 characters");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, VAULT_KDF.iterations);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    salt: bufToB64(salt),
    iv: bufToB64(iv),
    ciphertext: bufToB64(ciphertext),
    kdf: { ...VAULT_KDF }
  };
}

export async function decryptPayload<T = unknown>(passphrase: string, blob: VaultBlob): Promise<T> {
  if (!passphrase) throw new Error("Passphrase required");
  const salt = b64ToBuf(blob.salt);
  const iv = b64ToBuf(blob.iv);
  const ct = b64ToBuf(blob.ciphertext);
  const key = await deriveKey(passphrase, salt, blob.kdf.iterations);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    // AES-GCM auth failure is indistinguishable from corruption / wrong key.
    throw new Error("Decrypt failed — wrong passphrase or corrupted data");
  }
}
