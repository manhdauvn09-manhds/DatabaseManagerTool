/**
 * Single-use confirmation tokens for destructive ops (UPDATE / DELETE).
 *
 * Flow:
 *   1. Client requests preview → server calls `issueToken(payload)` and returns the token.
 *   2. Client shows preview + asks user to type the token.
 *   3. Client posts execute → server calls `consumeToken(token, payload)`.
 *      Token is consumed (deleted) on first use, valid for 2 minutes, and
 *      bound to the exact payload (SHA-256 hash) — substituting WHERE/SET later fails.
 */
import { createHash } from "node:crypto";

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

export function issueToken(payload: unknown): string {
  maybeCleanup();
  const token = genToken();
  store.set(token, {
    hash: hashPayload(payload),
    expiresAt: Date.now() + TTL_MS
  });
  return token;
}

export function consumeToken(token: string, payload: unknown): { ok: true } | { ok: false; reason: "missing" | "expired" | "mismatch" } {
  if (typeof token !== "string" || !/^[A-Z0-9]{8}$/.test(token)) return { ok: false, reason: "missing" };
  const rec = store.get(token);
  if (!rec) return { ok: false, reason: "missing" };
  store.delete(token); // single-use, regardless of validity
  if (Date.now() > rec.expiresAt) return { ok: false, reason: "expired" };
  if (rec.hash !== hashPayload(payload)) return { ok: false, reason: "mismatch" };
  return { ok: true };
}

export function resetTokens(): void { store.clear(); }

// Periodic sweep
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [t, v] of store) if (v.expiresAt < now) store.delete(t);
}, 60_000);
const unrefable = sweepTimer as unknown as { unref?: () => void };
if (typeof unrefable.unref === "function") unrefable.unref();
