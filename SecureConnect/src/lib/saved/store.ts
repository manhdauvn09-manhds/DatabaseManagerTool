/**
 * Server-side store for saved DB connection profiles.
 *
 * Plaintext credentials are encrypted at the store boundary using `serverVault`
 * (HKDF + AES-256-GCM with master key from env). The file on disk only contains
 * ciphertext + salt + iv per profile.
 *
 * Storage: a single JSON file at SAVED_CONNECTIONS_PATH (default /data/saved-connections.json).
 * User identity is hashed (SHA-256 of lowercased email) so the on-disk file does not reveal raw emails.
 * Atomic write via tmp + rename. Single in-process serial chain prevents lost updates.
 *
 * Schema versions:
 *   - v1 (legacy, client-encrypted with passphrase) — IGNORED on read, treated as empty.
 *   - v2 (current, server-encrypted with master key).
 */
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { encryptForUser, decryptForUser, type ServerVaultBlob } from "@/lib/crypto/serverVault";

const DEFAULT_PATH = "/data/saved-connections.json";
const MAX_PROFILES_PER_USER = 50;
const SCHEMA_VERSION = 2;

function storePath(): string {
  return process.env.SAVED_CONNECTIONS_PATH || DEFAULT_PATH;
}

export type ProfileMeta = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

type PersistedProfile = ProfileMeta & ServerVaultBlob;

type StoreShape = {
  version: typeof SCHEMA_VERSION;
  users: Record<string, { profiles: PersistedProfile[] }>;
};

function userKey(email: string): string {
  return createHash("sha256").update(email.toLowerCase().trim()).digest("hex");
}

let chain: Promise<void> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(() => fn());
  chain = run.then(() => undefined, () => undefined);
  return run;
}

async function readStore(): Promise<StoreShape> {
  try {
    const raw = await readFile(storePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.users === "object") {
      if (parsed.version === SCHEMA_VERSION) return parsed as StoreShape;
      if (parsed.version === 1) {
        // eslint-disable-next-line no-console
        console.warn("[saved/store] legacy v1 data found — ignoring (incompatible).");
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return { version: SCHEMA_VERSION, users: {} };
}

async function writeStore(data: StoreShape): Promise<void> {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(data), { mode: 0o600, encoding: "utf8" });
  await rename(tmp, path);
}

export async function listProfiles(email: string): Promise<ProfileMeta[]> {
  return withLock(async () => {
    const store = await readStore();
    const arr = store.users[userKey(email)]?.profiles ?? [];
    return arr.map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt }));
  });
}

export async function saveProfile(email: string, name: string, plaintext: string): Promise<ProfileMeta> {
  return withLock(async () => {
    const store = await readStore();
    const key = userKey(email);
    const u = store.users[key] ?? { profiles: [] };
    if (u.profiles.length >= MAX_PROFILES_PER_USER) {
      throw new Error(`Profile limit reached (${MAX_PROFILES_PER_USER})`);
    }
    const blob = encryptForUser(email, plaintext);
    const now = new Date().toISOString();
    const profile: PersistedProfile = {
      id: randomUUID(),
      name,
      createdAt: now,
      updatedAt: now,
      ...blob
    };
    u.profiles.push(profile);
    store.users[key] = u;
    await writeStore(store);
    return { id: profile.id, name: profile.name, createdAt: profile.createdAt, updatedAt: profile.updatedAt };
  });
}

export async function loadProfile(email: string, id: string): Promise<{ meta: ProfileMeta; plaintext: string } | null> {
  return withLock(async () => {
    const store = await readStore();
    const p = store.users[userKey(email)]?.profiles.find((x) => x.id === id);
    if (!p) return null;
    const plaintext = decryptForUser(email, { salt: p.salt, iv: p.iv, ciphertext: p.ciphertext });
    return {
      meta: { id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt },
      plaintext
    };
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
