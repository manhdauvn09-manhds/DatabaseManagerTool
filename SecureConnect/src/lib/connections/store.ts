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
};

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const TTL_MS = Math.max(
  60_000,
  Number(process.env.CONNECTION_TTL_MS ?? DEFAULT_TTL_MS)
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
 * Returns the record only if it belongs to `ownerEmail`. Prevents another signed-in
 * user from using someone else's connectionId.
 */
export function getConnectionRecord(id: string, ownerEmail: string): ConnectionRecord | null {
  const rec = store.get(id);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) {
    clearSecret(rec);
    store.delete(id);
    return null;
  }
  if (rec.ownerEmail !== ownerEmail) return null;
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

// Graceful shutdown — wipe store on SIGTERM/SIGINT to release secrets and stop timer.
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
