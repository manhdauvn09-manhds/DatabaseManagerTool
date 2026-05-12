import { NextResponse } from "next/server";
import { authorizeUser, jerr, logInternal } from "@/lib/db-api/route-helper";
import { loadProfile, deleteProfile } from "@/lib/saved/store";
import { ProfileIdSchema, PlainConnectionSchema } from "@/lib/saved/schemas";
import { isVaultConfigured } from "@/lib/crypto/serverVault";
import { audit } from "@/lib/security/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const a = await authorizeUser(req, "saved.load", { rateLimitMax: 30, rateLimitWindowMs: 60_000, rateLimitBucket: "saved" });
  if (!a.ok) return a.response;
  const { email, ip } = a.ctx;

  if (!isVaultConfigured()) {
    return jerr("VAULT_NOT_CONFIGURED", "Saved-connection feature not configured on this server", 503);
  }

  const idParse = ProfileIdSchema.safeParse(params.id);
  if (!idParse.success) return jerr("BAD_REQUEST", "Invalid profile id", 400);

  try {
    const result = await loadProfile(email, idParse.data);
    if (!result) {
      audit({ action: "saved.load", email, ip, ok: false, errCode: "NOT_FOUND" });
      return jerr("NOT_FOUND", "Profile not found", 404);
    }
    // The decrypted plaintext is a JSON-encoded PlainConnection. Validate before returning.
    let data: unknown;
    try { data = JSON.parse(result.plaintext); } catch {
      logInternal("saved.load", new Error("Decrypted plaintext is not JSON"));
      return jerr("DECRYPT_FAIL", "Stored profile is corrupted", 500);
    }
    const parsed = PlainConnectionSchema.safeParse(data);
    if (!parsed.success) {
      logInternal("saved.load", new Error("Decrypted JSON does not match schema"));
      return jerr("DECRYPT_FAIL", "Stored profile is corrupted", 500);
    }
    audit({ action: "saved.load", email, ip, ok: true });
    return NextResponse.json({ profile: result.meta, data: parsed.data });
  } catch (e) {
    logInternal("saved.load", e);
    audit({ action: "saved.load", email, ip, ok: false, errCode: "STORE_FAIL" });
    return jerr("STORE_FAIL", "Load failed", 500);
  }
}

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
