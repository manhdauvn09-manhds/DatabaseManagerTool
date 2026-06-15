import { NextResponse } from "next/server";
import { authorizeUser, jerr, logInternal } from "@/lib/db-api/route-helper";
import { revokePat } from "@/lib/tokens/patStore";
import { audit } from "@/lib/security/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// DELETE /api/tokens/:id — revoke a PAT. Session-only, owner-checked.
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const a = await authorizeUser(req, "token.revoke", { rateLimitMax: 30, rateLimitWindowMs: 60_000, sessionOnly: true });
  if (!a.ok) return a.response;
  const { ctx } = a;
  try {
    const ok = await revokePat(params.id, ctx.email);
    audit({ action: "token.revoke", email: ctx.email, ip: ctx.ip, ok });
    if (!ok) return jerr("TOKEN_NOT_FOUND", "Token not found or not yours.", 404);
    return NextResponse.json({ revoked: true });
  } catch (e) {
    logInternal("token.revoke", e);
    return jerr("TOKEN_REVOKE_FAIL", "Failed to revoke token", 500);
  }
}
