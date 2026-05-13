/**
 * Encrypted snapshot of rows about to be deleted. Written to /tmp by default.
 *
 * Format on disk (JSON):
 *   {
 *     "meta": { ts, email, connectionId, database, table, rowCount, encrypted: true },
 *     "blob": { salt, iv, ciphertext }  // AES-256-GCM via serverVault
 *   }
 *
 * Decrypting requires VAULT_MASTER_SECRET + the meta.email (used in HKDF info).
 * If VAULT_MASTER_SECRET is missing, the backup is SKIPPED (returns null) and
 * the DELETE still proceeds — backup is best-effort.
 */
import { mkdir, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { encryptForUser, isVaultConfigured } from "@/lib/crypto/serverVault";

const BACKUP_DIR = process.env.BACKUP_DIR ?? "/tmp/dbmanager-backups";
const RETENTION_MS = 24 * 60 * 60 * 1000;

function safeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Buffer || value instanceof Uint8Array) return `0x${Buffer.from(value).toString("hex")}`;
  return value;
}

export async function writeBackup(input: {
  email: string;
  connectionId: string;
  database: string;
  table: string;
  rows: Record<string, unknown>[];
}): Promise<string | null> {
  if (!isVaultConfigured()) {
    // eslint-disable-next-line no-console
    console.warn("[backup] VAULT_MASTER_SECRET not configured — skipping encrypted backup");
    return null;
  }

  await mkdir(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${ts}__${safeSegment(input.database)}__${safeSegment(input.table)}__${input.connectionId.slice(0, 8)}.json`;
  const path = join(BACKUP_DIR, name);

  const plaintext = JSON.stringify({ rows: input.rows }, jsonReplacer);
  const blob = encryptForUser(input.email, plaintext);

  const body = {
    meta: {
      ts: new Date().toISOString(),
      email: input.email,
      connectionId: input.connectionId,
      database: input.database,
      table: input.table,
      rowCount: input.rows.length,
      encrypted: true
    },
    blob
  };
  await writeFile(path, JSON.stringify(body, null, 2), { encoding: "utf8", mode: 0o600 });
  gcOldBackups().catch(() => undefined);
  return path;
}

async function gcOldBackups(): Promise<void> {
  let entries: string[];
  try { entries = await readdir(BACKUP_DIR); } catch { return; }
  const cutoff = Date.now() - RETENTION_MS;
  await Promise.allSettled(entries.map(async (name) => {
    if (!name.endsWith(".json")) return;
    const p = join(BACKUP_DIR, name);
    const s = await stat(p).catch(() => null);
    if (s && s.mtimeMs < cutoff) await unlink(p).catch(() => undefined);
  }));
}
