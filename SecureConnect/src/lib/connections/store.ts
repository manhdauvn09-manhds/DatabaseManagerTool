import { v4 as uuidv4 } from "uuid";

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
  // Stored in-memory only; never persisted.
  password: string;
  // Optional: IP that the SSRF check already validated. Drivers should use this
  // (not `host`) when opening sockets — defends against DNS rebinding between
  // the safety check and the actual connection.
  resolvedIp?: string;
};

// Per-request TTL bump (sliding window). On each successful get, expiresAt is set
// to min(now + TTL_MS, createdAt + MAX_SESSION_MS).
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 min
const TTL_MS = Math.max(
  60_000,
  Number(process.env.CONNECTION_TTL_MS ?? DEFAULT_TTL_MS)
);

// Hard cap on total session duration regardless of activity.
const DEFAULT_MAX_SESSION_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_SESSION_MS = Math.max(
  TTL_MS,
  Number(process.env.CONNECTION_MAX_SESSION_MS ?? DEFAULT_MAX_SESSION_MS)
);

const MAX_RECORDS = Math.max(
  10,
  Number(process.env.CONNECTION_MAX_RECORDS ?? "1000")
);

const store = new Map<string, ConnectionRecord>();

// Best-effort: drop the password reference so it becomes eligible for GC.
// JS strings are immutable so underlying memory cannot be zeroed deterministically.
function clearSecret(rec: ConnectionRecord): void {
  rec.password = "";
}

export function createConnectionRecord(
  input: Omit<ConnectionRecord, "id" | "createdAt" | "expiresAt">
): ConnectionRecord {
  if (store.size >= MAX_RECORDS) {
    cleanupExpired();
    if (store.size >= MAX_RECORDS) {
      const oldestKey = store.keys().next().value;
      if (oldestKey) {
        const oldest = store.get(oldestKey);
        if (oldest) clearSecret(oldest);
        store.delete(oldestKey);
      }
    }
  }
  const id = uuidv4();
  const now = Date.now();
  const rec: ConnectionRecord = {
    id,
    createdAt: now,
    expiresAt: now + TTL_MS,
    ...input
  };
  store.set(id, rec);
  return rec;
}

/**
 * Returns the record only if it belongs to `ownerEmail`.
 * Side effect: on success, slides expiresAt forward (TTL_MS) — capped at createdAt + MAX_SESSION_MS.
 */
export function getConnectionRecord(id: string, ownerEmail: string): ConnectionRecord | null {
  const rec = store.get(id);
  if (!rec) return null;
  const now = Date.now();
  if (now > rec.expiresAt) {
    clearSecret(rec);
    store.delete(id);
    return null;
  }
  if (rec.ownerEmail !== ownerEmail) return null;
  // Sliding TTL with session cap.
  const sessionCap = rec.createdAt + MAX_SESSION_MS;
  rec.expiresAt = Math.min(now + TTL_MS, sessionCap);
  return rec;
}

export function deleteConnectionRecord(id: string): void {
  const rec = store.get(id);
  if (rec) clearSecret(rec);
  store.delete(id);
}

export function cleanupExpired(): void {
  const now = Date.now();
  for (const [id, rec] of store) {
    if (now > rec.expiresAt) {
      clearSecret(rec);
      store.delete(id);
    }
  }
}

// Periodic sweep so idle records are freed even without inbound traffic.
const sweepTimer = setInterval(cleanupExpired, 60_000);
const unrefable = sweepTimer as unknown as { unref?: () => void };
if (typeof unrefable.unref === "function") unrefable.unref();

function shutdown(): void {
  clearInterval(sweepTimer);
  for (const [id, rec] of store) {
    clearSecret(rec);
    store.delete(id);
  }
}
if (typeof process !== "undefined" && typeof process.once === "function") {
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
