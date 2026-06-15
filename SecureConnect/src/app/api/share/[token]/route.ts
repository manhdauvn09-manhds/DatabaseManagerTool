import { NextResponse } from "next/server";
import { authorizeUser, jerr, logInternal } from "@/lib/db-api/route-helper";
import { getShare, revokeShare } from "@/lib/sharing/shareStore";
import { getConnectionRecord } from "@/lib/connections/store";
import { audit } from "@/lib/security/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/share/:token — resolve a share (sharee bootstrap). Any signed-in user.
// Returns the connectionId + dbType so the read-only viewer can drive the
// existing /api/db/:id/* read routes with an x-share-token header.
export async function GET(req: Request, { params }: { params: { token: string } }) {
  const a = await authorizeUser(req, "share.resolve", { rateLimitMax: 60, rateLimitWindowMs: 60_000 });
  if (!a.ok) return a.response;
  const { ctx } = a;

  const share = await getShare(params.token);
  if (!share) {
    audit({ action: "share.resolve", email: ctx.email, ip: ctx.ip, ok: false, errCode: "SHARE_INVALID" });
    return jerr("SHARE_INVALID", "Share link is invalid or expired.", 404);
  }
  // Confirm the owner's connection is still alive (also yields dbType).
  const rec = await getConnectionRecord(share.connectionId, share.ownerEmail);
  if (!rec) {
    audit({ action: "share.resolve", email: ctx.email, ip: ctx.ip, ok: false, errCode: "CONNECTION_NOT_FOUND" });
    return jerr("CONNECTION_NOT_FOUND", "Shared connection has expired.", 404);
  }
  audit({ action: "share.resolve", email: ctx.email, ip: ctx.ip, host: rec.host, port: rec.port, dbType: rec.dbType, ok: true });
  return NextResponse.json({
    connectionId: share.connectionId,
    dbType: rec.dbType,
    readonly: true,
    expiresAt: share.expiresAt
  });
}

// DELETE /api/share/:token — revoke. Only the owner may revoke.
export async function DELETE(req: Request, { params }: { params: { token: string } }) {
  const a = await authorizeUser(req, "share.revoke", { rateLimitMax: 30, rateLimitWindowMs: 60_000 });
  if (!a.ok) return a.response;
  const { ctx } = a;
  try {
    const ok = await revokeShare(params.token, ctx.email);
    audit({ action: "share.revoke", email: ctx.email, ip: ctx.ip, ok });
    if (!ok) return jerr("SHARE_NOT_FOUND", "Share not found or not yours.", 404);
    return NextResponse.json({ revoked: true });
  } catch (e) {
    logInternal("share.revoke", e);
    return jerr("SHARE_REVOKE_FAIL", "Failed to revoke share", 500);
  }
}
