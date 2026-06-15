import { NextResponse } from "next/server";
import { authorizeUser, jerr, logInternal } from "@/lib/db-api/route-helper";
import { getConnectionRecord } from "@/lib/connections/store";
import { createShare, listShares } from "@/lib/sharing/shareStore";
import { audit } from "@/lib/security/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_REGEX = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_BODY = 2 * 1024;

// GET /api/share — list the caller's active shares.
export async function GET(req: Request) {
  const a = await authorizeUser(req, "share.list", { rateLimitMax: 60, rateLimitWindowMs: 60_000 });
  if (!a.ok) return a.response;
  const { ctx } = a;
  try {
    const shares = await listShares(ctx.email);
    // Never leak ownerEmail back; expose only what the owner needs.
    const out = shares.map((s) => ({ token: s.token, connectionId: s.connectionId, createdAt: s.createdAt, expiresAt: s.expiresAt }));
    return NextResponse.json({ shares: out });
  } catch (e) {
    logInternal("share.list", e);
    return jerr("SHARE_LIST_FAIL", "Failed to list shares", 500);
  }
}

// POST /api/share { connectionId, ttlSec? } — create a read-only share link.
export async function POST(req: Request) {
  const a = await authorizeUser(req, "share.create", { rateLimitMax: 20, rateLimitWindowMs: 60_000 });
  if (!a.ok) return a.response;
  const { ctx } = a;

  const raw = await req.text();
  if (raw.length > MAX_BODY) return jerr("BODY_TOO_LARGE", "Payload too large", 413);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return jerr("BAD_REQUEST", "Invalid JSON", 400); }

  const { connectionId, ttlSec } = body as { connectionId?: string; ttlSec?: number };
  if (!connectionId || !UUID_REGEX.test(connectionId)) {
    return jerr("BAD_CONNECTION_ID", "Invalid connection id", 400);
  }

  // Ownership gate: only the connection's owner may share it.
  const rec = await getConnectionRecord(connectionId, ctx.email);
  if (!rec) {
    audit({ action: "share.create", email: ctx.email, ip: ctx.ip, ok: false, errCode: "CONNECTION_NOT_FOUND" });
    return jerr("CONNECTION_NOT_FOUND", "Connection not found or expired.", 404);
  }

  try {
    const share = await createShare(connectionId, ctx.email, typeof ttlSec === "number" ? ttlSec : undefined);
    audit({ action: "share.create", email: ctx.email, ip: ctx.ip, host: rec.host, port: rec.port, dbType: rec.dbType, ok: true });
    return NextResponse.json({ token: share.token, connectionId, expiresAt: share.expiresAt });
  } catch (e) {
    logInternal("share.create", e);
    const msg = e instanceof Error ? e.message : "Failed to create share";
    const isCap = /Too many active shares/i.test(msg);
    return jerr("SHARE_CREATE_FAIL", isCap ? msg : "Failed to create share", isCap ? 400 : 500);
  }
}
