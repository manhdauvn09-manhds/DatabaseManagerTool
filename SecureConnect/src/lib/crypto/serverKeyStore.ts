/**
 * RSA-OAEP keypair for client-side password encryption (defense-in-depth over HTTPS).
 *
 * Persistence (NEW):
 *   - If VAULT_MASTER_SECRET is configured, the keypair is persisted to
 *     SERVER_KEYPAIR_PATH (default /data/server-keypair.json), encrypted at rest
 *     with serverVault (AES-256-GCM). This survives container restarts/deploys so
 *     users with an in-flight session don't get spurious KEY_ROTATED errors.
 *   - If VAULT_MASTER_SECRET is NOT set, falls back to the original ephemeral
 *     behaviour (fresh keypair per process, rotates on restart).
 *
 * Threat model: same as saved profiles. File leak alone is useless (needs master);
 * master leak alone is useless (needs file). Both = operator-level.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { encryptForUser, decryptForUser, isVaultConfigured, type ServerVaultBlob } from "./serverVault";

const KEYPAIR_PATH = process.env.SERVER_KEYPAIR_PATH || "/data/server-keypair.json";
// Fixed pseudo-identity for HKDF info — namespaced so it can never collide with a
// real user email (which always contains '@').
const SYSTEM_IDENTITY = "__system__:rsa-keypair";

type CachedKey = {
  keyId: string;
  publicJwk: JsonWebKey;
  privateKey: CryptoKey;
};

type PersistedShape = {
  keyId: string;
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
};

let cached: CachedKey | undefined;
// Guard against concurrent first-time init racing to generate two keypairs.
let initInFlight: Promise<CachedKey> | undefined;

const ALGO: RsaHashedKeyGenParams = {
  name: "RSA-OAEP",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256"
};
const IMPORT_ALGO: RsaHashedImportParams = { name: "RSA-OAEP", hash: "SHA-256" };

function randomId(): string {
  return crypto.randomUUID();
}

async function importPrivate(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, IMPORT_ALGO, true, ["decrypt"]);
}

async function loadPersisted(): Promise<CachedKey | null> {
  if (!isVaultConfigured()) return null;
  let raw: string;
  try {
    raw = await readFile(KEYPAIR_PATH, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      // eslint-disable-next-line no-console
      console.warn("[serverKeyStore] read failed:", e instanceof Error ? e.message : String(e));
    }
    return null;
  }
  try {
    const blob = JSON.parse(raw) as ServerVaultBlob;
    const json = decryptForUser(SYSTEM_IDENTITY, blob);
    const parsed = JSON.parse(json) as PersistedShape;
    if (!parsed.keyId || !parsed.publicJwk || !parsed.privateJwk) return null;
    const privateKey = await importPrivate(parsed.privateJwk);
    return { keyId: parsed.keyId, publicJwk: parsed.publicJwk, privateKey };
  } catch (e) {
    // Master rotated, corrupted, or schema mismatch — regenerate fresh.
    // eslint-disable-next-line no-console
    console.warn("[serverKeyStore] persisted keypair unusable, regenerating:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

async function persist(keyId: string, publicJwk: JsonWebKey, privateKey: CryptoKey): Promise<void> {
  if (!isVaultConfigured()) return;
  try {
    const privateJwk = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
    const payload: PersistedShape = { keyId, publicJwk, privateJwk };
    const blob = encryptForUser(SYSTEM_IDENTITY, JSON.stringify(payload));
    await mkdir(dirname(KEYPAIR_PATH), { recursive: true });
    await writeFile(KEYPAIR_PATH, JSON.stringify(blob), { mode: 0o600, encoding: "utf8" });
  } catch (e) {
    // Non-fatal: app still works with the in-memory key, just won't survive restart.
    // eslint-disable-next-line no-console
    console.warn("[serverKeyStore] persist failed:", e instanceof Error ? e.message : String(e));
  }
}

async function generate(): Promise<CachedKey> {
  const keyPair = (await crypto.subtle.generateKey(ALGO, true, ["encrypt", "decrypt"])) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
  const keyId = randomId();
  await persist(keyId, publicJwk, keyPair.privateKey);
  return { keyId, publicJwk, privateKey: keyPair.privateKey };
}

export async function getOrCreateServerKey(): Promise<CachedKey> {
  if (cached) return cached;
  if (initInFlight) return initInFlight;
  initInFlight = (async () => {
    const loaded = await loadPersisted();
    cached = loaded ?? (await generate());
    return cached;
  })();
  try {
    return await initInFlight;
  } finally {
    initInFlight = undefined;
  }
}

export async function decryptBase64RSAOAEP(ciphertextB64: string): Promise<string> {
  const { privateKey } = await getOrCreateServerKey();
  const bytes = Buffer.from(ciphertextB64, "base64");
  const plaintext = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, bytes);
  return new TextDecoder().decode(plaintext);
}

// Test helper — reset module cache so a test can re-init with different env.
export function _resetServerKeyCache(): void {
  cached = undefined;
  initInFlight = undefined;
}
