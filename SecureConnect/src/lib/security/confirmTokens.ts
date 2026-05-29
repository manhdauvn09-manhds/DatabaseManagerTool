/**
 * Single-use confirmation tokens for destructive ops (UPDATE / DELETE).
 * Async API, two backends:
 *   - in-memory (default): per-process Map + sweep.
 *   - Redis (REDIS_URL set): SET NX EX + GETDEL (atomic single-use), shared across instances.
 *
 * Token is consumed on first use, valid 2 minutes, bound to the exact payload
 * (SHA-256 hash) so substituting WHERE/SET between preview and execute fails.
 */
import { createHash } from "node:crypto";
import { getRedis } from "@/lib/redis/client";

const TTL_MS = 2 * 60_000;
const MAX_ACTIVE = 10_000;

type Entry = { hash: string; expiresAt: number };
const store = new Map<string, Entry>();

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // exclude 0/O/1/I/L
const TOKEN_LEN = 8;

function genToken(): string {
  const bytes = new Uint8Array(TOKEN_LEN);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < TOKEN_LEN; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function maybeCleanup(): void {
  if (store.size < MAX_ACTIVE) return;
  const now = Date.now();
  for (const [t, v] of store) if (v.expiresAt < now) store.delete(t);
}

export type ConsumeResult = { ok: true } | { ok: false; reason: "missing" | "expired" | "mismatch" };

export async function issueToken(payload: unknown): Promise<string> {
  const token = genToken();
  const hash = hashPayload(payload);
  const r = getRedis();
  if (r) {
    try {
      await r.set(`ct:${token}`, hash, "PX", TTL_MS, "NX");
      return token;
    } catch {
      // fall through to in-memory
    }
  }
  maybeCleanup();
  store.set(token, { hash, expiresAt: Date.now() + TTL_MS });
  return token;
}

export async function consumeToken(token: string, payload: unknown): Promise<ConsumeResult> {
  if (typeof token !== "string" || !/^[A-Z0-9]{8}$/.test(token)) return { ok: false, reason: "missing" };
  const expected = hashPayload(payload);
  const r = getRedis();
  if (r) {
    try {
      // GETDEL: atomic single-use. Returns the stored hash or null.
      const stored = await r.getdel(`ct:${token}`);
      if (stored === null) return { ok: false, reason: "missing" };
      return stored === expected ? { ok: true } : { ok: false, reason: "mismatch" };
    } catch {
      // fall through to in-memory
    }
  }
  const rec = store.get(token);
  if (!rec) return { ok: false, reason: "missing" };
  store.delete(token); // single-use regardless of validity
  if (Date.now() > rec.expiresAt) return { ok: false, reason: "expired" };
  if (rec.hash !== expected) return { ok: false, reason: "mismatch" };
  return { ok: true };
}

export function resetTokens(): void { store.clear(); }

// Periodic sweep (in-memory backend only).
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [t, v] of store) if (v.expiresAt < now) store.delete(t);
}, 60_000);
const unrefable = sweepTimer as unknown as { unref?: () => void };
if (typeof unrefable.unref === "function") unrefable.unref();
