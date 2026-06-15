import { NextResponse } from "next/server";
import { authorizeUser, jerr, logInternal } from "@/lib/db-api/route-helper";
import { createPat, listPats } from "@/lib/tokens/patStore";
import { audit } from "@/lib/security/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 2 * 1024;

// GET /api/tokens — list the caller's PAT metadata (never the token). Session-only.
export async function GET(req: Request) {
  const a = await authorizeUser(req, "token.list", { rateLimitMax: 60, rateLimitWindowMs: 60_000, sessionOnly: true });
  if (!a.ok) return a.response;
  const { ctx } = a;
  try {
    const tokens = await listPats(ctx.email);
    return NextResponse.json({ tokens });
  } catch (e) {
    logInternal("token.list", e);
    return jerr("TOKEN_LIST_FAIL", "Failed to list tokens", 500);
  }
}

// POST /api/tokens { label, ttlSec? } — create a PAT. Returns the token ONCE.
// Session-only: a leaked PAT must not be able to mint new PATs.
export async function POST(req: Request) {
  const a = await authorizeUser(req, "token.create", { rateLimitMax: 10, rateLimitWindowMs: 60_000, sessionOnly: true });
  if (!a.ok) return a.response;
  const { ctx } = a;

  const raw = await req.text();
  if (raw.length > MAX_BODY) return jerr("BODY_TOO_LARGE", "Payload too large", 413);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return jerr("BAD_REQUEST", "Invalid JSON", 400); }

  const { label, ttlSec } = body as { label?: string; ttlSec?: number };
  if (!label || typeof label !== "string" || label.trim().length === 0) {
    return jerr("BAD_REQUEST", "label is required", 400);
  }

  try {
    const { token, meta } = await createPat(ctx.email, label.trim(), typeof ttlSec === "number" ? ttlSec : undefined);
    audit({ action: "token.create", email: ctx.email, ip: ctx.ip, ok: true });
    // `token` is returned exactly once — the server stores only its hash.
    return NextResponse.json({ token, meta });
  } catch (e) {
    logInternal("token.create", e);
    const msg = e instanceof Error ? e.message : "Failed to create token";
    const isCap = /Too many tokens/i.test(msg);
    return jerr("TOKEN_CREATE_FAIL", isCap ? msg : "Failed to create token", isCap ? 400 : 500);
  }
}
