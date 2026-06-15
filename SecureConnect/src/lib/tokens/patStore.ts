/**
 * Personal Access Tokens (PAT) for non-browser API clients (the CLI).
 *
 * A PAT authenticates API requests via `Authorization: Bearer <token>` and acts
 * as the user who created it. Tokens are shown to the user ONCE at creation;
 * only a SHA-256 hash is stored (256-bit random secret → no brute-force risk).
 *
 * Backends (same pattern as shareStore / connection store):
 *   - Redis (REDIS_URL set): `patmeta:<id>` record + `pat:<hash>`→id + `patidx:<ownerHash>` set.
 *   - in-memory (default): Maps + sweep. (Dev only; prod has Redis so PATs persist.)
 *
 * SECURITY:
 *   - PAT auth SKIPS the Origin/CSRF check (Bearer tokens aren't auto-sent by
 *     browsers, so CSRF doesn't apply) — handled in route-helper.
 *   - PAT management routes are session-only (a leaked PAT cannot mint/list PATs).
 */
import { randomBytes, createHash } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getRedis } from "@/lib/redis/client";

export type PatRecord = {
  id: string;
  email: string;
  label: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number | null; // null = no expiry
  lastUsedAt: number | null;
};

// What we expose to the owner (never the hash).
export type PatMeta = Omit<PatRecord, "tokenHash">;

const PREFIX = "dbm_pat_";
const TOKEN_BYTES = 32;
const MAX_PATS_PER_OWNER = 25;
const MAX_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year cap

function genToken(): string {
  return PREFIX + randomBytes(TOKEN_BYTES).toString("base64url");
}
function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
function ownerHash(email: string): string {
  return createHash("sha256").update(email).digest("hex");
}

// ---------- in-memory backend ----------
const metaById = new Map<string, PatRecord>();
const idByHash = new Map<string, string>();
const idsByOwner = new Map<string, Set<string>>();

function memSweep(): void {
  const now = Date.now();
  for (const [id, rec] of metaById) {
    if (rec.expiresAt !== null && now > rec.expiresAt) memDelete(rec);
  }
}
function memDelete(rec: PatRecord): void {
  metaById.delete(rec.id);
  idByHash.delete(rec.tokenHash);
  idsByOwner.get(ownerHash(rec.email))?.delete(rec.id);
}

const MKEY = (id: string) => `patmeta:${id}`;
const HKEY = (hash: string) => `pat:${hash}`;
const IKEY = (oh: string) => `patidx:${oh}`;

function strip(rec: PatRecord): PatMeta {
  const { tokenHash, ...meta } = rec;
  return meta;
}

// ---------- public API ----------

export async function createPat(
  email: string,
  label: string,
  ttlSec?: number
): Promise<{ token: string; meta: PatMeta }> {
  const existing = await listPats(email);
  if (existing.length >= MAX_PATS_PER_OWNER) {
    throw new Error(`Too many tokens (max ${MAX_PATS_PER_OWNER}) — revoke some first`);
  }
  const now = Date.now();
  const token = genToken();
  const rec: PatRecord = {
    id: uuidv4(),
    email,
    label: (label || "token").slice(0, 80),
    tokenHash: hashToken(token),
    createdAt: now,
    expiresAt: ttlSec && Number.isFinite(ttlSec) ? now + Math.min(ttlSec * 1000, MAX_TTL_MS) : null,
    lastUsedAt: null
  };
  const oh = ownerHash(email);

  const r = getRedis();
  if (r) {
    try {
      const px = rec.expiresAt ? rec.expiresAt - now : undefined;
      if (px) {
        await r.set(MKEY(rec.id), JSON.stringify(rec), "PX", px);
        await r.set(HKEY(rec.tokenHash), rec.id, "PX", px);
      } else {
        await r.set(MKEY(rec.id), JSON.stringify(rec));
        await r.set(HKEY(rec.tokenHash), rec.id);
      }
      await r.sadd(IKEY(oh), rec.id);
      return { token, meta: strip(rec) };
    } catch {
      // fall through to in-memory
    }
  }
  metaById.set(rec.id, rec);
  idByHash.set(rec.tokenHash, rec.id);
  if (!idsByOwner.has(oh)) idsByOwner.set(oh, new Set());
  idsByOwner.get(oh)!.add(rec.id);
  return { token, meta: strip(rec) };
}

/** Verify a Bearer token → owner email, or null. Updates lastUsedAt best-effort. */
export async function verifyPat(raw: string): Promise<{ email: string; id: string } | null> {
  if (typeof raw !== "string" || !raw.startsWith(PREFIX) || raw.length > 200) return null;
  const hash = hashToken(raw);
  const now = Date.now();

  const r = getRedis();
  if (r) {
    try {
      const id = await r.get(HKEY(hash));
      if (!id) return null;
      const raw2 = await r.get(MKEY(id));
      if (!raw2) return null;
      const rec = JSON.parse(raw2) as PatRecord;
      if (rec.expiresAt !== null && now > rec.expiresAt) return null;
      rec.lastUsedAt = now;
      const px = rec.expiresAt ? rec.expiresAt - now : undefined;
      if (px) await r.set(MKEY(id), JSON.stringify(rec), "PX", px);
      else await r.set(MKEY(id), JSON.stringify(rec));
      return { email: rec.email, id: rec.id };
    } catch {
      // fall through
    }
  }
  const id = idByHash.get(hash);
  if (!id) return null;
  const rec = metaById.get(id);
  if (!rec) return null;
  if (rec.expiresAt !== null && now > rec.expiresAt) { memDelete(rec); return null; }
  rec.lastUsedAt = now;
  return { email: rec.email, id: rec.id };
}

export async function listPats(email: string): Promise<PatMeta[]> {
  const oh = ownerHash(email);
  const now = Date.now();
  const r = getRedis();
  if (r) {
    try {
      const ids = await r.smembers(IKEY(oh));
      const out: PatMeta[] = [];
      for (const id of ids) {
        const raw = await r.get(MKEY(id));
        if (!raw) { await r.srem(IKEY(oh), id); continue; }
        try {
          const rec = JSON.parse(raw) as PatRecord;
          if (rec.expiresAt !== null && now > rec.expiresAt) { await r.srem(IKEY(oh), id); continue; }
          out.push(strip(rec));
        } catch { await r.srem(IKEY(oh), id); }
      }
      return out.sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      // fall through
    }
  }
  memSweep();
  const ids = idsByOwner.get(oh);
  if (!ids) return [];
  const out: PatMeta[] = [];
  for (const id of ids) {
    const rec = metaById.get(id);
    if (rec) out.push(strip(rec));
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function revokePat(id: string, email: string): Promise<boolean> {
  const r = getRedis();
  if (r) {
    try {
      const raw = await r.get(MKEY(id));
      if (!raw) return false;
      const rec = JSON.parse(raw) as PatRecord;
      if (rec.email !== email) return false;
      await r.del(MKEY(id));
      await r.del(HKEY(rec.tokenHash));
      await r.srem(IKEY(ownerHash(email)), id);
      return true;
    } catch {
      // fall through
    }
  }
  const rec = metaById.get(id);
  if (!rec || rec.email !== email) return false;
  memDelete(rec);
  return true;
}

export function resetPats(): void {
  metaById.clear();
  idByHash.clear();
  idsByOwner.clear();
}

// Periodic sweep (in-memory backend only).
const sweepTimer = setInterval(memSweep, 60_000);
const unrefable = sweepTimer as unknown as { unref?: () => void };
if (typeof unrefable.unref === "function") unrefable.unref();
