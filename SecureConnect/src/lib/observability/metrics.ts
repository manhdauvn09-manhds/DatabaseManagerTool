/**
 * Lightweight app metrics: per-action request counters + latency, plus schema
 * cache hit/miss. Backed by Redis when REDIS_URL is set (shared across
 * instances, survives restarts); falls back to an in-process store otherwise.
 *
 * Recording is fire-and-forget and never throws — observability must not be
 * able to break a request.
 */
import { getRedis } from "@/lib/redis/client";

const REQ_PREFIX = "metrics:req:"; // hash per action: count, errors, ms_total, ms_max
const CACHE_KEY = "metrics:cache"; // hash: hits, misses
const SINCE_KEY = "metrics:since"; // ISO timestamp of first record

export type ActionStat = {
  action: string;
  count: number;
  errors: number;
  avgMs: number;
  maxMs: number;
  errorRate: number;
};

export type MetricsSnapshot = {
  since: string | null;
  backend: "redis" | "memory";
  totals: { count: number; errors: number; errorRate: number; avgMs: number };
  actions: ActionStat[];
  cache: { hits: number; misses: number; hitRate: number };
};

// ---- in-memory fallback ----
type Mem = {
  since: string | null;
  req: Map<string, { count: number; errors: number; msTotal: number; msMax: number }>;
  cache: { hits: number; misses: number };
};
const mem: Mem = { since: null, req: new Map(), cache: { hits: 0, misses: 0 } };

function stampSince(): string {
  // Callers pass a timestamp; avoid Date.now surprises by using ISO here is fine
  // because this runs server-side at request time (not in a workflow sandbox).
  return new Date().toISOString();
}

export function recordRequest(action: string, ok: boolean, ms: number): void {
  const redis = getRedis();
  if (redis) {
    const key = REQ_PREFIX + action;
    redis
      .multi()
      .hincrby(key, "count", 1)
      .hincrby(key, "errors", ok ? 0 : 1)
      .hincrby(key, "ms_total", Math.max(0, Math.round(ms)))
      .set(SINCE_KEY, stampSince(), "EX", 60 * 60 * 24 * 90, "NX")
      .exec()
      .then(() => redis.hget(key, "ms_max"))
      .then((cur) => {
        const prev = Number(cur ?? 0);
        if (ms > prev) return redis.hset(key, "ms_max", Math.round(ms));
      })
      .catch(() => { /* observability must never throw */ });
    return;
  }
  // memory
  if (!mem.since) mem.since = stampSince();
  const cur = mem.req.get(action) ?? { count: 0, errors: 0, msTotal: 0, msMax: 0 };
  cur.count += 1;
  if (!ok) cur.errors += 1;
  cur.msTotal += Math.max(0, ms);
  cur.msMax = Math.max(cur.msMax, ms);
  mem.req.set(action, cur);
}

export function recordCache(hit: boolean): void {
  const redis = getRedis();
  if (redis) {
    redis.hincrby(CACHE_KEY, hit ? "hits" : "misses", 1).catch(() => { /* ignore */ });
    return;
  }
  if (hit) mem.cache.hits += 1;
  else mem.cache.misses += 1;
}

function toStat(action: string, count: number, errors: number, msTotal: number, msMax: number): ActionStat {
  return {
    action,
    count,
    errors,
    avgMs: count > 0 ? Math.round(msTotal / count) : 0,
    maxMs: Math.round(msMax),
    errorRate: count > 0 ? +(errors / count).toFixed(4) : 0
  };
}

export async function getMetricsSnapshot(): Promise<MetricsSnapshot> {
  const redis = getRedis();
  if (redis) {
    const [keys, since, cacheHash] = await Promise.all([
      redis.keys(`${process.env.REDIS_PREFIX ?? "dbm:"}${REQ_PREFIX}*`),
      redis.get(SINCE_KEY),
      redis.hgetall(CACHE_KEY)
    ]);
    // ioredis keys() returns fully-prefixed keys; strip the client keyPrefix.
    const prefix = process.env.REDIS_PREFIX ?? "dbm:";
    const actions: ActionStat[] = [];
    let tCount = 0, tErr = 0, tMs = 0;
    for (const fullKey of keys) {
      const logicalKey = fullKey.startsWith(prefix) ? fullKey.slice(prefix.length) : fullKey;
      const action = logicalKey.slice(REQ_PREFIX.length);
      const h = await redis.hgetall(logicalKey);
      const count = Number(h.count ?? 0);
      const errors = Number(h.errors ?? 0);
      const msTotal = Number(h.ms_total ?? 0);
      const msMax = Number(h.ms_max ?? 0);
      actions.push(toStat(action, count, errors, msTotal, msMax));
      tCount += count; tErr += errors; tMs += msTotal;
    }
    actions.sort((a, b) => b.count - a.count);
    const hits = Number(cacheHash?.hits ?? 0);
    const misses = Number(cacheHash?.misses ?? 0);
    return {
      since: since ?? null,
      backend: "redis",
      totals: { count: tCount, errors: tErr, errorRate: tCount ? +(tErr / tCount).toFixed(4) : 0, avgMs: tCount ? Math.round(tMs / tCount) : 0 },
      actions,
      cache: { hits, misses, hitRate: hits + misses ? +(hits / (hits + misses)).toFixed(4) : 0 }
    };
  }

  const actions: ActionStat[] = [];
  let tCount = 0, tErr = 0, tMs = 0;
  for (const [action, v] of mem.req) {
    actions.push(toStat(action, v.count, v.errors, v.msTotal, v.msMax));
    tCount += v.count; tErr += v.errors; tMs += v.msTotal;
  }
  actions.sort((a, b) => b.count - a.count);
  const { hits, misses } = mem.cache;
  return {
    since: mem.since,
    backend: "memory",
    totals: { count: tCount, errors: tErr, errorRate: tCount ? +(tErr / tCount).toFixed(4) : 0, avgMs: tCount ? Math.round(tMs / tCount) : 0 },
    actions,
    cache: { hits, misses, hitRate: hits + misses ? +(hits / (hits + misses)).toFixed(4) : 0 }
  };
}

// Test helper.
export function _resetMetricsMemory(): void {
  mem.since = null;
  mem.req.clear();
  mem.cache = { hits: 0, misses: 0 };
}
