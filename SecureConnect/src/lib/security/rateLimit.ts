/**
 * Sliding-window rate limiter. Async API with two backends:
 *   - in-memory (default): per-process Map.
 *   - Redis (when REDIS_URL set): ZSET sliding window, shared across instances.
 */
import { getRedis } from "@/lib/redis/client";

type Entry = { hits: number[] };
const store = new Map<string, Entry>();

const CLEANUP_INTERVAL_MS = 60_000;
const STALE_ENTRY_MS = 10 * 60_000;
let lastCleanup = Date.now();

function maybeCleanup(now: number): void {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  for (const [k, v] of store) {
    if (v.hits.length === 0 || now - v.hits[v.hits.length - 1] > STALE_ENTRY_MS) {
      store.delete(k);
    }
  }
}

export type RateLimitResult =
  | { ok: true; remaining: number }
  | { ok: false; retryAfter: number };

function inMemory(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  maybeCleanup(now);
  const entry = store.get(key) ?? { hits: [] };
  while (entry.hits.length > 0 && now - entry.hits[0] >= windowMs) entry.hits.shift();
  if (entry.hits.length >= limit) {
    const oldest = entry.hits[0];
    return { ok: false, retryAfter: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)) };
  }
  entry.hits.push(now);
  store.set(key, entry);
  return { ok: true, remaining: limit - entry.hits.length };
}

async function viaRedis(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const r = getRedis();
  if (!r) return inMemory(key, limit, windowMs);
  const now = Date.now();
  const zkey = `rl:${key}`;
  const member = `${now}-${crypto.randomUUID()}`;
  try {
    const pipe = r.multi();
    pipe.zremrangebyscore(zkey, 0, now - windowMs);   // drop expired
    pipe.zadd(zkey, now, member);                      // record this hit
    pipe.zcard(zkey);                                  // count in window
    pipe.pexpire(zkey, windowMs);                      // ttl
    const res = await pipe.exec();
    // res: array of [err, value]; zcard is index 2
    const count = Number((res?.[2]?.[1] as number) ?? 0);
    if (count > limit) {
      // Over limit: remove the hit we just added so it doesn't count against later windows.
      await r.zrem(zkey, member);
      const oldest = await r.zrange(zkey, 0, 0, "WITHSCORES");
      const oldestTs = oldest && oldest[1] ? Number(oldest[1]) : now;
      return { ok: false, retryAfter: Math.max(1, Math.ceil((windowMs - (now - oldestTs)) / 1000)) };
    }
    return { ok: true, remaining: Math.max(0, limit - count) };
  } catch {
    // Redis hiccup → fail open to in-memory (availability over strictness).
    return inMemory(key, limit, windowMs);
  }
}

export async function rateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  if (getRedis()) return viaRedis(key, limit, windowMs);
  return inMemory(key, limit, windowMs);
}

export function resetRateLimit(key?: string): void {
  if (key === undefined) store.clear();
  else store.delete(key);
}

export function getClientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}
