import { v4 as uuidv4 } from "uuid";
import { getRedis } from "@/lib/redis/client";
import { encryptForUser, decryptForUser, isVaultConfigured, type ServerVaultBlob } from "@/lib/crypto/serverVault";

export type DbType = "auto" | "mysql" | "postgresql" | "mssql";

export type DbConnectPayload = {
  dbType: DbType;
  host: string;
  port: number;
  user?: string;
  password: string;
};

export type ConnectionRecord = {
  id: string;
  ownerEmail: string;
  createdAt: number;
  expiresAt: number;
  dbType: Exclude<DbType, "auto">;
  host: string;
  port: number;
  user?: string;
  // In-memory mode: plaintext. Redis mode: never persisted plaintext (see below).
  password: string;
  // Optional: IP that the SSRF check already validated. Drivers use this (not
  // `host`) when opening sockets — DNS-rebinding defense.
  resolvedIp?: string;
};

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 min sliding
const TTL_MS = Math.max(60_000, Number(process.env.CONNECTION_TTL_MS ?? DEFAULT_TTL_MS));
const DEFAULT_MAX_SESSION_MS = 2 * 60 * 60 * 1000; // 2h hard cap
const MAX_SESSION_MS = Math.max(TTL_MS, Number(process.env.CONNECTION_MAX_SESSION_MS ?? DEFAULT_MAX_SESSION_MS));
const MAX_RECORDS = Math.max(10, Number(process.env.CONNECTION_MAX_RECORDS ?? "1000"));

// ---------- Redis decision ----------
// Connection records hold a DECRYPTED DB password. We only persist them to Redis
// when a vault master is configured, so the password can be encrypted at rest
// (AES-256-GCM via serverVault). Without a master we keep records in-memory even
// if REDIS_URL is set — never write plaintext credentials to Redis.
function useRedis(): boolean {
  return !!getRedis() && isVaultConfigured();
}

// ---------- in-memory backend ----------
const store = new Map<string, ConnectionRecord>();

function clearSecret(rec: ConnectionRecord): void { rec.password = ""; }

function memCleanup(): void {
  const now = Date.now();
  for (const [id, rec] of store) {
    if (now > rec.expiresAt) { clearSecret(rec); store.delete(id); }
  }
}

// ---------- Redis serialization (password encrypted) ----------
type RedisRecord = Omit<ConnectionRecord, "password"> & { pw: ServerVaultBlob };
const RKEY = (id: string) => `conn:${id}`;

function toRedis(rec: ConnectionRecord): RedisRecord {
  const { password, ...rest } = rec;
  return { ...rest, pw: encryptForUser(rec.ownerEmail, password) };
}
function fromRedis(raw: string): ConnectionRecord | null {
  try {
    const r = JSON.parse(raw) as RedisRecord;
    const password = decryptForUser(r.ownerEmail, r.pw);
    return {
      id: r.id,
      ownerEmail: r.ownerEmail,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      dbType: r.dbType,
      host: r.host,
      port: r.port,
      user: r.user,
      resolvedIp: r.resolvedIp,
      password
    };
  } catch {
    return null;
  }
}

// ---------- public API (async) ----------

export async function createConnectionRecord(
  input: Omit<ConnectionRecord, "id" | "createdAt" | "expiresAt">
): Promise<ConnectionRecord> {
  const id = uuidv4();
  const now = Date.now();
  const rec: ConnectionRecord = { id, createdAt: now, expiresAt: now + TTL_MS, ...input };

  if (useRedis()) {
    const r = getRedis()!;
    await r.set(RKEY(id), JSON.stringify(toRedis(rec)), "PX", TTL_MS);
    return rec;
  }

  // in-memory: enforce MAX_RECORDS with opportunistic cleanup + oldest-eviction.
  if (store.size >= MAX_RECORDS) {
    memCleanup();
    if (store.size >= MAX_RECORDS) {
      const oldestKey = store.keys().next().value;
      if (oldestKey) {
        const oldest = store.get(oldestKey);
        if (oldest) clearSecret(oldest);
        store.delete(oldestKey);
      }
    }
  }
  store.set(id, rec);
  return rec;
}

/**
 * Return the record only if it belongs to `ownerEmail`. Side effect: slides
 * expiresAt forward (TTL_MS), capped at createdAt + MAX_SESSION_MS.
 */
export async function getConnectionRecord(id: string, ownerEmail: string): Promise<ConnectionRecord | null> {
  const now = Date.now();

  if (useRedis()) {
    const r = getRedis()!;
    const raw = await r.get(RKEY(id));
    if (!raw) return null;
    const rec = fromRedis(raw);
    if (!rec) return null;
    if (rec.ownerEmail !== ownerEmail) return null;
    // Slide TTL with session cap.
    const sessionCap = rec.createdAt + MAX_SESSION_MS;
    const remaining = Math.max(1, Math.min(now + TTL_MS, sessionCap) - now);
    rec.expiresAt = now + remaining;
    await r.set(RKEY(id), JSON.stringify(toRedis(rec)), "PX", remaining);
    return rec;
  }

  const rec = store.get(id);
  if (!rec) return null;
  if (now > rec.expiresAt) { clearSecret(rec); store.delete(id); return null; }
  if (rec.ownerEmail !== ownerEmail) return null;
  const sessionCap = rec.createdAt + MAX_SESSION_MS;
  rec.expiresAt = Math.min(now + TTL_MS, sessionCap);
  return rec;
}

export async function deleteConnectionRecord(id: string): Promise<void> {
  if (useRedis()) { await getRedis()!.del(RKEY(id)); return; }
  const rec = store.get(id);
  if (rec) clearSecret(rec);
  store.delete(id);
}

// In-memory housekeeping only; Redis uses native TTL.
export async function cleanupExpired(): Promise<void> {
  if (useRedis()) return;
  memCleanup();
}

// Periodic sweep (in-memory only).
const sweepTimer = setInterval(memCleanup, 60_000);
const unrefable = sweepTimer as unknown as { unref?: () => void };
if (typeof unrefable.unref === "function") unrefable.unref();

function shutdown(): void {
  clearInterval(sweepTimer);
  for (const [id, rec] of store) { clearSecret(rec); store.delete(id); }
}
if (typeof process !== "undefined" && typeof process.once === "function") {
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
