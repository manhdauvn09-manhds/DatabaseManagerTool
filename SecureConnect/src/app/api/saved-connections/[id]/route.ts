import { NextResponse } from "next/server";
import { authorizeUser, jerr, logInternal } from "@/lib/db-api/route-helper";
import { deleteProfile } from "@/lib/saved/store";
import { ProfileIdSchema } from "@/lib/saved/schemas";
import { audit } from "@/lib/security/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const a = await authorizeUser(req, "saved.delete", { rateLimitMax: 15, rateLimitWindowMs: 60_000, rateLimitBucket: "saved" });
  if (!a.ok) return a.response;
  const { email, ip } = a.ctx;

  const idParse = ProfileIdSchema.safeParse(params.id);
  if (!idParse.success) return jerr("BAD_REQUEST", "Invalid profile id", 400);

  try {
    const removed = await deleteProfile(email, idParse.data);
    if (!removed) return jerr("NOT_FOUND", "Profile not found", 404);
    audit({ action: "saved.delete", email, ip, ok: true });
    return NextResponse.json({ removed: true });
  } catch (e) {
    logInternal("saved.delete", e);
    audit({ action: "saved.delete", email, ip, ok: false, errCode: "STORE_FAIL" });
    return jerr("STORE_FAIL", "Delete failed", 500);
  }
}
