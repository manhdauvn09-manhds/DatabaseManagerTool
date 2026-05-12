/**
 * Server-side store for end-to-end encrypted DB connection profiles.
 *
 * The server only sees ciphertext + salt + iv + KDF params — NEVER plaintext.
 * The key to decrypt is derived client-side from the user's vault passphrase
 * (PBKDF2-SHA256 200k iterations) and never sent to the server.
 *
 * Storage: a single JSON file at SAVED_CONNECTIONS_PATH (env, default /data/saved-connections.json).
 * User identity is hashed (SHA-256 of lowercased email) so the on-disk file does not reveal raw emails.
 * Atomic write via tmp + rename. In-process write lock prevents lost updates.
 */
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { SaveProfileInput } from "./schemas";

const DEFAULT_PATH = "/data/saved-connections.json";
const MAX_PROFILES_PER_USER = 50;

// Path is read on every call so tests / runtime env changes are honored.
function storePath(): string {
  return process.env.SAVED_CONNECTIONS_PATH || DEFAULT_PATH;
}

export type EncryptedProfile = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  salt: string;
  iv: string;
  ciphertext: string;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number };
};

type StoreShape = {
  version: 1;
  users: Record<string, { profiles: EncryptedProfile[] }>;
};

function userKey(email: string): string {
  return createHash("sha256").update(email.toLowerCase().trim()).digest("hex");
}

// Single serial chain — all read-modify-write ops go through it.
let chain: Promise<void> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(() => fn());
  // Ensure the chain itself never rejects (so subsequent locks keep working).
  chain = run.then(() => undefined, () => undefined);
  return run;
}

async function readStore(): Promise<StoreShape> {
  try {
    const raw = await readFile(storePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.version === 1 && typeof parsed.users === "object") {
      return parsed as StoreShape;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return { version: 1, users: {} };
}

async function writeStore(data: StoreShape): Promise<void> {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(data), { mode: 0o600, encoding: "utf8" });
  await rename(tmp, path); // atomic on POSIX
}

export async function listProfiles(email: string): Promise<EncryptedProfile[]> {
  return withLock(async () => {
    const store = await readStore();
    return store.users[userKey(email)]?.profiles ?? [];
  });
}

export async function saveProfile(email: string, input: SaveProfileInput): Promise<EncryptedProfile> {
  return withLock(async () => {
    const store = await readStore();
    const key = userKey(email);
    const u = store.users[key] ?? { profiles: [] };
    if (u.profiles.length >= MAX_PROFILES_PER_USER) {
      throw new Error(`Profile limit reached (${MAX_PROFILES_PER_USER})`);
    }
    const now = new Date().toISOString();
    const profile: EncryptedProfile = {
      id: randomUUID(),
      name: input.name,
      createdAt: now,
      updatedAt: now,
      salt: input.salt,
      iv: input.iv,
      ciphertext: input.ciphertext,
      kdf: input.kdf
    };
    u.profiles.push(profile);
    store.users[key] = u;
    await writeStore(store);
    return profile;
  });
}

export async function deleteProfile(email: string, id: string): Promise<boolean> {
  return withLock(async () => {
    const store = await readStore();
    const key = userKey(email);
    const u = store.users[key];
    if (!u) return false;
    const before = u.profiles.length;
    u.profiles = u.profiles.filter((p) => p.id !== id);
    if (u.profiles.length === before) return false;
    store.users[key] = u;
    await writeStore(store);
    return true;
  });
}
