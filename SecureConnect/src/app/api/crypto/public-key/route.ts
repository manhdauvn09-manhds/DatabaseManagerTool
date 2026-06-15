import { NextResponse } from "next/server";
import { authorizeUser } from "@/lib/db-api/route-helper";
import { getOrCreateServerKey } from "@/lib/crypto/serverKeyStore";

export const runtime = "nodejs";

export async function GET(req: Request) {
  // Cookie session OR Bearer PAT (CLI needs the public key to encrypt before /api/connect).
  const a = await authorizeUser(req, "crypto.publicKey", { rateLimitMax: 30, rateLimitWindowMs: 60_000, rateLimitBucket: "pubkey" });
  if (!a.ok) return a.response;

  const { keyId, publicJwk } = await getOrCreateServerKey();
  return NextResponse.json({ keyId, publicJwk });
}
