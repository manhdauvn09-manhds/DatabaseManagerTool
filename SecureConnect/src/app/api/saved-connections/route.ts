import { NextResponse } from "next/server";
import { authorizeUser, jerr, logInternal } from "@/lib/db-api/route-helper";
import { listProfiles, saveProfile } from "@/lib/saved/store";
import { SaveProfileSchema } from "@/lib/saved/schemas";
import { audit } from "@/lib/security/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;

export async function GET(req: Request) {
  const a = await authorizeUser(req, "saved.list", { rateLimitMax: 30, rateLimitWindowMs: 60_000, rateLimitBucket: "saved" });
  if (!a.ok) return a.response;
  const { email, ip } = a.ctx;
  try {
    const profiles = await listProfiles(email);
    audit({ action: "saved.list", email, ip, ok: true });
    return NextResponse.json({ profiles });
  } catch (e) {
    logInternal("saved.list", e);
    audit({ action: "saved.list", email, ip, ok: false, errCode: "STORE_FAIL" });
    return jerr("STORE_FAIL", "Failed to load saved connections", 500);
  }
}

export async function POST(req: Request) {
  const a = await authorizeUser(req, "saved.create", { rateLimitMax: 15, rateLimitWindowMs: 60_000, rateLimitBucket: "saved" });
  if (!a.ok) return a.response;
  const { email, ip } = a.ctx;

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return jerr("BODY_TOO_LARGE", "Payload too large", 413);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return jerr("BAD_REQUEST", "Invalid JSON", 400); }

  const parsed = SaveProfileSchema.safeParse(body);
  if (!parsed.success) {
    audit({ action: "saved.create", email, ip, ok: false, errCode: "BAD_REQUEST" });
    return jerr("BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid payload", 400);
  }

  try {
    const profile = await saveProfile(email, parsed.data);
    audit({ action: "saved.create", email, ip, ok: true });
    return NextResponse.json({ profile });
  } catch (e) {
    logInternal("saved.create", e);
    audit({ action: "saved.create", email, ip, ok: false, errCode: "STORE_FAIL" });
    const msg = e instanceof Error ? e.message : "Save failed";
    const isLimit = /limit reached/i.test(msg);
    return jerr(isLimit ? "PROFILE_LIMIT" : "STORE_FAIL", isLimit ? msg : "Save failed", isLimit ? 400 : 500);
  }
}
