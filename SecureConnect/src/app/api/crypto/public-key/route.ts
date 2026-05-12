import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getOrCreateServerKey } from "@/lib/crypto/serverKeyStore";
import { rateLimit, getClientIp } from "@/lib/security/rateLimit";

export const runtime = "nodejs";

export async function GET(req: Request) {
  // Middleware already enforces auth on /api/* (except /api/auth). This is defense-in-depth.
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json(
      { error: { code: "UNAUTH", message: "Sign-in required" } },
      { status: 401 }
    );
  }

  const ip = getClientIp(req);
  const rl = rateLimit(`pubkey:${ip}`, 30, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: { code: "RATE_LIMIT", message: "Too many requests" } },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }
    );
  }

  const { keyId, publicJwk } = await getOrCreateServerKey();
  return NextResponse.json({ keyId, publicJwk });
}
