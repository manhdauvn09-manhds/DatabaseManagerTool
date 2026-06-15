/**
 * Read-only share links for live connections.
 *
 * A share is a bearer capability: a high-entropy token that grants READ-ONLY
 * access to ONE connectionId, on behalf of its owner, until it expires or is
 * revoked. The token never carries credentials — it only references the owner's
 * live in-memory/Redis connection record (which holds the encrypted password).
 *
 * Two backends (same pattern as confirmTokens / connection store):
 *   - Redis (REDIS_URL set): `share:<token>` JSON + PX TTL, `shareidx:<ownerHash>`
 *     set for listing. Shared across instances, survives restart.
 *   - in-memory (default): per-process Maps + sweep.
 *
 * SECURITY: read-only is enforced at the ROUTE layer — only read routes pass
 * `allowShare`. A share token presented to a mutation route is ignored.
 */
import { randomBytes, createHash } from "node:crypto";
import { getRedis } from "@/lib/redis/client";

export type Share = {
  token: string;
  connectionId: string;
  ownerEmail: string;
  createdAt: number;
  expiresAt: number;
};

const DEFAULT_TTL_MS = 60 * 60 * 1000;        // 1h
const MAX_TTL_MS = 24 * 60 * 60 * 1000;       // 24h
const MIN_TTL_MS = 60 * 1000;                 // 1m
const TOKEN_BYTES = 32;                        // 256-bit capability
const MAX_SHARES_PER_OWNER = 50;

function genToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}
function ownerHash(email: string): string {
  return createHash("sha256").update(email).digest("hex");
}
function clampTtl(ttlSec?: number): number {
  const ms = ttlSec && Number.isFinite(ttlSec) ? ttlSec * 1000 : DEFAULT_TTL_MS;
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, ms));
}

// ---------- in-memory backend ----------
const store = new Map<string, Share>();
const ownerIndex = new Map<string, Set<string>>();

function memSweep(): void {
  const now = Date.now();
  for (const [t, s] of store) {
    if (now > s.expiresAt) {
      store.delete(t);
      ownerIndex.get(ownerHash(s.ownerEmail))?.delete(t);
    }
  }
}

const RKEY = (token: string) => `share:${token}`;
const IKEY = (oh: string) => `shareidx:${oh}`;

// ---------- public API ----------

export async function createShare(connectionId: string, ownerEmail: string, ttlSec?: number): Promise<Share> {
  const now = Date.now();
  const ttl = clampTtl(ttlSec);
  const share: Share = { token: genToken(), connectionId, ownerEmail, createdAt: now, expiresAt: now + ttl };
  const oh = ownerHash(ownerEmail);

  // Enforce per-owner cap (prune expired first).
  const existing = await listShares(ownerEmail);
  if (existing.length >= MAX_SHARES_PER_OWNER) {
    throw new Error(`Too many active shares (max ${MAX_SHARES_PER_OWNER}) — revoke some first`);
  }

  const r = getRedis();
  if (r) {
    try {
      await r.set(RKEY(share.token), JSON.stringify(share), "PX", ttl);
      await r.sadd(IKEY(oh), share.token);
      await r.pexpire(IKEY(oh), MAX_TTL_MS);
      return share;
    } catch {
      // fall through to in-memory
    }
  }
  store.set(share.token, share);
  if (!ownerIndex.has(oh)) ownerIndex.set(oh, new Set());
  ownerIndex.get(oh)!.add(share.token);
  return share;
}

export async function getShare(token: string): Promise<Share | null> {
  if (typeof token !== "string" || token.length < 16 || token.length > 128) return null;
  const r = getRedis();
  if (r) {
    try {
      const raw = await r.get(RKEY(token));
      if (!raw) return null;
      const s = JSON.parse(raw) as Share;
      if (Date.now() > s.expiresAt) return null;
      return s;
    } catch {
      // fall through
    }
  }
  const s = store.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    store.delete(token);
    ownerIndex.get(ownerHash(s.ownerEmail))?.delete(token);
    return null;
  }
  return s;
}

export async function revokeShare(token: string, ownerEmail: string): Promise<boolean> {
  const s = await getShare(token);
  if (!s || s.ownerEmail !== ownerEmail) return false;
  const oh = ownerHash(ownerEmail);
  const r = getRedis();
  if (r) {
    try {
      await r.del(RKEY(token));
      await r.srem(IKEY(oh), token);
      return true;
    } catch {
      // fall through
    }
  }
  store.delete(token);
  ownerIndex.get(oh)?.delete(token);
  return true;
}

export async function listShares(ownerEmail: string): Promise<Share[]> {
  const oh = ownerHash(ownerEmail);
  const r = getRedis();
  if (r) {
    try {
      const tokens = await r.smembers(IKEY(oh));
      const out: Share[] = [];
      for (const t of tokens) {
        const raw = await r.get(RKEY(t));
        if (!raw) {
          await r.srem(IKEY(oh), t); // prune expired
          continue;
        }
        try {
          const s = JSON.parse(raw) as Share;
          if (Date.now() <= s.expiresAt) out.push(s);
        } catch {
          await r.srem(IKEY(oh), t);
        }
      }
      return out.sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      // fall through
    }
  }
  memSweep();
  const set = ownerIndex.get(oh);
  if (!set) return [];
  const out: Share[] = [];
  for (const t of set) {
    const s = store.get(t);
    if (s && Date.now() <= s.expiresAt) out.push(s);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function resetShares(): void {
  store.clear();
  ownerIndex.clear();
}

// Periodic sweep (in-memory backend only).
const sweepTimer = setInterval(memSweep, 60_000);
const unrefable = sweepTimer as unknown as { unref?: () => void };
if (typeof unrefable.unref === "function") unrefable.unref();
