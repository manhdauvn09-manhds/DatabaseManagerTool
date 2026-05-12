import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getClientIp, rateLimit } from "@/lib/security/rateLimit";
import { audit } from "@/lib/security/auditLog";
import { getConnectionRecord, type ConnectionRecord } from "@/lib/connections/store";

export type UserCtx = { email: string; ip: string };
export type RouteCtx = UserCtx & { rec: ConnectionRecord };

const UUID_REGEX = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function originOk(req: Request): boolean {
  const expectedOrigin = process.env.AUTH_URL?.toLowerCase();
  if (!expectedOrigin) return true;
  const origin = req.headers.get("origin")?.toLowerCase();
  const referer = req.headers.get("referer")?.toLowerCase();
  if (origin && origin === expectedOrigin) return true;
  if (!origin && referer && referer.startsWith(expectedOrigin)) return true;
  return false;
}

export type AuthorizeResult<T> = { ok: true; ctx: T } | { ok: false; response: NextResponse };

/**
 * Authorize a request as an authenticated user — checks session + Origin/Referer + rate limit.
 * Returns email + ip. Use this for endpoints that don't operate on a specific connection.
 */
export async function authorizeUser(
  req: Request,
  action: string,
  opts: { rateLimitMax?: number; rateLimitWindowMs?: number; rateLimitBucket?: string } = {}
): Promise<AuthorizeResult<UserCtx>> {
  const ip = getClientIp(req);

  const session = await auth();
  if (!session?.user?.email) {
    audit({ action, ip, ok: false, errCode: "UNAUTH" });
    return { ok: false, response: jerr("UNAUTH", "Sign-in required", 401) };
  }
  const email = session.user.email;

  if (!originOk(req)) {
    audit({ action, email, ip, ok: false, errCode: "BAD_ORIGIN" });
    return { ok: false, response: jerr("FORBIDDEN", "Bad origin", 403) };
  }

  const bucket = opts.rateLimitBucket ?? "dbapi";
  const rl = rateLimit(`${bucket}:${email}`, opts.rateLimitMax ?? 60, opts.rateLimitWindowMs ?? 60_000);
  if (!rl.ok) {
    audit({ action, email, ip, ok: false, errCode: "RATE_LIMIT" });
    return {
      ok: false,
      response: jerr("RATE_LIMIT", "Too many requests", 429, { "Retry-After": String(rl.retryAfter) })
    };
  }

  return { ok: true, ctx: { email, ip } };
}

/**
 * Authorize a request + resolve a connection record by id + ownership.
 */
export async function authorize(
  req: Request,
  connectionId: string,
  action: string,
  opts: { rateLimitMax?: number; rateLimitWindowMs?: number } = {}
): Promise<AuthorizeResult<RouteCtx>> {
  const u = await authorizeUser(req, action, opts);
  if (!u.ok) return u;
  const { email, ip } = u.ctx;

  if (typeof connectionId !== "string" || !UUID_REGEX.test(connectionId)) {
    audit({ action, email, ip, ok: false, errCode: "BAD_CONNECTION_ID" });
    return { ok: false, response: jerr("BAD_CONNECTION_ID", "Invalid connection id", 400) };
  }

  const rec = getConnectionRecord(connectionId, email);
  if (!rec) {
    audit({ action, email, ip, ok: false, errCode: "CONNECTION_NOT_FOUND" });
    return { ok: false, response: jerr("CONNECTION_NOT_FOUND", "Connection not found or expired. Please reconnect.", 404) };
  }

  return { ok: true, ctx: { email, ip, rec } };
}

export function jerr(code: string, message: string, status: number, headers?: Record<string, string>): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

export function logInternal(prefix: string, e: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[${prefix}]`, e instanceof Error ? e.message : String(e));
}
