/** Redis-backed schema cache (5min TTL) for listTables / listColumns. Reduces DB introspection overhead. */

import { getRedis } from "@/lib/redis/client";

const CACHE_TTL_SECONDS = 5 * 60; // 5 minutes

/** Cache key for table list. */
function cacheKeyTables(connId: string, db: string): string {
  return `schema:tables:${connId}:${db}`;
}

/** Cache key for column list. */
function cacheKeyCols(connId: string, db: string, table: string): string {
  return `schema:cols:${connId}:${db}:${table}`;
}

export async function getTablesFromCache(
  connId: string,
  db: string
): Promise<string[] | null> {
  const redis = getRedis();
  if (!redis) return null;

  try {
    const cached = await redis.get(cacheKeyTables(connId, db));
    return cached ? JSON.parse(cached) : null;
  } catch {
    return null;
  }
}

export async function setTablesToCache(
  connId: string,
  db: string,
  tables: string[]
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  try {
    await redis.setex(cacheKeyTables(connId, db), CACHE_TTL_SECONDS, JSON.stringify(tables));
  } catch {
    // Fail silently; cache miss on next request
  }
}

export async function getColumnsFromCache(
  connId: string,
  db: string,
  table: string
): Promise<Record<string, string> | null> {
  const redis = getRedis();
  if (!redis) return null;

  try {
    const cached = await redis.get(cacheKeyCols(connId, db, table));
    return cached ? JSON.parse(cached) : null;
  } catch {
    return null;
  }
}

export async function setColumnsToCache(
  connId: string,
  db: string,
  table: string,
  cols: Record<string, string>
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  try {
    await redis.setex(cacheKeyCols(connId, db, table), CACHE_TTL_SECONDS, JSON.stringify(cols));
  } catch {
    // Fail silently
  }
}

/** Invalidate all schema cache for a connection (after schema changes). */
export async function invalidateConnectionSchemaCache(connId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  try {
    const keys = await redis.keys(`schema:*:${connId}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch {
    // Fail silently
  }
}
