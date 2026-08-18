import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getClientIp, rateLimit } from "@/lib/security/rateLimit";
import { audit } from "@/lib/security/auditLog";
import { getConnectionRecord, type ConnectionRecord } from "@/lib/connections/store";
import { getShare } from "@/lib/sharing/shareStore";
import { verifyPat } from "@/lib/tokens/patStore";

export type UserCtx = { email: string; ip: string };
// `readonly` is true when access was granted via a read-only share link (not owner).
export type RouteCtx = UserCtx & { rec: ConnectionRecord; readonly: boolean };

const SHARE_HEADER = "x-share-token";

const UUID_REGEX = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function originOk(req: Request): boolean {
  const expectedOrigin = process.env.AUTH_URL?.toLowerCase();
  // S-1 fix: fail-closed when AUTH_URL is not configured — never allow arbitrary origins.
  if (!expectedOrigin) return false;
  const origin = req.headers.get("origin")?.toLowerCase();
  const referer = req.headers.get("referer")?.toLowerCase();
  if (origin && origin === expectedOrigin) return true;
  if (!origin && referer && referer.startsWith(expectedOrigin)) return true;
  return false;
}

function extractBearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

export type AuthorizeResult<T> = { ok: true; ctx: T } | { ok: false; response: NextResponse };

/**
 * Authorize a request as an authenticated user — session (cookie) OR Personal
 * Access Token (`Authorization: Bearer <token>`), then rate limit.
 *
 * - Cookie session: Origin/Referer (CSRF) checked.
 * - Bearer PAT: CSRF check SKIPPED (bearer tokens aren't auto-sent by browsers),
 *   used by the CLI. Set `opts.sessionOnly` to reject PAT (e.g. token-management
 *   routes — a leaked PAT must not be able to mint/list/revoke PATs).
 */
export async function authorizeUser(
  req: Request,
  action: string,
  opts: { rateLimitMax?: number; rateLimitWindowMs?: number; rateLimitBucket?: string; sessionOnly?: boolean } = {}
): Promise<AuthorizeResult<UserCtx>> {
  const ip = getClientIp(req);

  let email: string | null = null;

  // Bearer PAT path (non-browser clients). Disabled when sessionOnly.
  if (!opts.sessionOnly) {
    const bearer = extractBearer(req);
    if (bearer) {
      const pat = await verifyPat(bearer);
      if (!pat) {
        audit({ action, ip, ok: false, errCode: "BAD_TOKEN" });
        return { ok: false, response: jerr("UNAUTH", "Invalid or expired access token", 401) };
      }
      email = pat.email;
      // No Origin check for token auth (not cookie-based → no CSRF surface).
    }
  }

  if (!email) {
    const session = await auth();
    if (!session?.user?.email) {
      audit({ action, ip, ok: false, errCode: "UNAUTH" });
      return { ok: false, response: jerr("UNAUTH", "Sign-in required", 401) };
    }
    email = session.user.email;

    if (!originOk(req)) {
      audit({ action, email, ip, ok: false, errCode: "BAD_ORIGIN" });
      return { ok: false, response: jerr("FORBIDDEN", "Bad origin", 403) };
    }
  }

  const bucket = opts.rateLimitBucket ?? "dbapi";
  const rl = await rateLimit(`${bucket}:${email}`, opts.rateLimitMax ?? 60, opts.rateLimitWindowMs ?? 60_000);
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
 * Authorize a request + resolve a connection record by id.
 *
 * Default: owner-only (record must belong to the session email).
 * When `opts.allowShare` is true AND the request carries a valid `x-share-token`
 * header, a non-owner is granted READ-ONLY access to the owner's record
 * (ctx.readonly = true).
 *
 * Routes that write MUST pass `mutation: true`. That is enforced here, not by
 * convention: a readonly (share) caller reaching a mutation route is refused,
 * and declaring both `allowShare` and `mutation` is rejected outright as a
 * configuration error. Before this, the ONLY thing keeping shares read-only was
 * remembering not to pass allowShare on a write handler — and `ctx.readonly`
 * was computed but never read anywhere, so there was no second line of defense.
 */
export async function authorize(
  req: Request,
  connectionId: string,
  action: string,
  opts: {
    rateLimitMax?: number;
    rateLimitWindowMs?: number;
    allowShare?: boolean;
    /** Route performs a write. Refuses share (read-only) callers. */
    mutation?: boolean;
  } = {}
): Promise<AuthorizeResult<RouteCtx>> {
  // Contradictory declaration — fail closed rather than pick a winner silently.
  if (opts.allowShare && opts.mutation) {
    logInternal("authorize.config", new Error(`${action}: allowShare + mutation are mutually exclusive`));
    return { ok: false, response: jerr("FORBIDDEN", "Not permitted", 403) };
  }
  const u = await authorizeUser(req, action, opts);
  if (!u.ok) return u;
  const { email, ip } = u.ctx;

  if (typeof connectionId !== "string" || !UUID_REGEX.test(connectionId)) {
    audit({ action, email, ip, ok: false, errCode: "BAD_CONNECTION_ID" });
    return { ok: false, response: jerr("BAD_CONNECTION_ID", "Invalid connection id", 400) };
  }

  // A share token presented to a write route is refused explicitly rather than
  // ignored. Ignoring it also denies (the owner-scoped lookup below fails), but
  // it lands in the audit log as CONNECTION_NOT_FOUND — indistinguishable from a
  // stale link. "Someone tried to write through a read-only share" is precisely
  // the event worth being able to see later, so it gets its own code.
  if (opts.mutation && req.headers.get(SHARE_HEADER)) {
    audit({ action, email, ip, ok: false, errCode: "SHARE_READONLY" });
    return { ok: false, response: jerr("FORBIDDEN", "Share links are read-only.", 403) };
  }

  // Read-only share path — only when the route opts in.
  const shareToken = opts.allowShare && !opts.mutation ? req.headers.get(SHARE_HEADER) : null;
  if (shareToken) {
    const share = await getShare(shareToken);
    if (!share || share.connectionId !== connectionId) {
      audit({ action, email, ip, ok: false, errCode: "SHARE_INVALID" });
      return { ok: false, response: jerr("SHARE_INVALID", "Share link is invalid or expired.", 403) };
    }
    const rec = await getConnectionRecord(connectionId, share.ownerEmail);
    if (!rec) {
      audit({ action, email, ip, ok: false, errCode: "CONNECTION_NOT_FOUND" });
      return { ok: false, response: jerr("CONNECTION_NOT_FOUND", "Shared connection has expired.", 404) };
    }
    const ctx: RouteCtx = { email, ip, rec, readonly: true };
    // Belt-and-braces: even if the guards above are ever loosened, a readonly
    // context must never reach a write.
    if (opts.mutation) {
      audit({ action, email, ip, ok: false, errCode: "SHARE_READONLY" });
      return { ok: false, response: jerr("FORBIDDEN", "Share links are read-only.", 403) };
    }
    return { ok: true, ctx };
  }

  const rec = await getConnectionRecord(connectionId, email);
  if (!rec) {
    audit({ action, email, ip, ok: false, errCode: "CONNECTION_NOT_FOUND" });
    return { ok: false, response: jerr("CONNECTION_NOT_FOUND", "Connection not found or expired. Please reconnect.", 404) };
  }

  return { ok: true, ctx: { email, ip, rec, readonly: false } };
}

export function jerr(code: string, message: string, status: number, headers?: Record<string, string>): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

export function logInternal(prefix: string, e: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[${prefix}]`, e instanceof Error ? e.message : String(e));
}
