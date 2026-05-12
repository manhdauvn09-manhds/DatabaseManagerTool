import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Public liveness probe. Returns 200 with minimal info — no auth required, no secrets.
// Used by Docker HEALTHCHECK and external uptime monitors.
export async function GET() {
  return NextResponse.json({ ok: true, ts: new Date().toISOString() });
}
