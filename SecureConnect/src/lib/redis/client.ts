/**
 * Lazy Redis client (ioredis). Returns null when REDIS_URL is not configured —
 * every store falls back to its in-memory backend in that case, preserving the
 * single-instance behaviour. When REDIS_URL is set, state is shared across
 * instances (horizontal scale) and survives app restarts.
 */
import Redis from "ioredis";

let client: Redis | null | undefined;

export function isRedisEnabled(): boolean {
  return !!process.env.REDIS_URL;
}

export function getRedis(): Redis | null {
  if (client !== undefined) return client;
  const url = process.env.REDIS_URL;
  if (!url) {
    client = null;
    return null;
  }
  client = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    // Namespacing so multiple apps can share one Redis safely.
    keyPrefix: process.env.REDIS_PREFIX ?? "dbm:"
  });
  client.on("error", (e) => {
    // eslint-disable-next-line no-console
    console.error("[redis] error:", e instanceof Error ? e.message : String(e));
  });
  return client;
}

// Test helper.
export function _resetRedisClient(): void {
  if (client) { try { client.disconnect(); } catch { /* ignore */ } }
  client = undefined;
}
