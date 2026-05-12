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

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  maybeCleanup(now);

  const entry = store.get(key) ?? { hits: [] };
  // Drop hits outside the window.
  while (entry.hits.length > 0 && now - entry.hits[0] >= windowMs) {
    entry.hits.shift();
  }

  if (entry.hits.length >= limit) {
    const oldest = entry.hits[0];
    return { ok: false, retryAfter: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)) };
  }

  entry.hits.push(now);
  store.set(key, entry);
  return { ok: true, remaining: limit - entry.hits.length };
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
