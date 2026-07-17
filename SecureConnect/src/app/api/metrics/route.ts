import { NextResponse } from "next/server";
import { authorizeUser, jerr, logInternal } from "@/lib/db-api/route-helper";
import { getMetricsSnapshot } from "@/lib/observability/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/metrics — aggregated app metrics (request counts, latency, error rate,
// schema-cache hit rate). Session-only: a leaked PAT should not expose ops data.
export async function GET(req: Request) {
  const a = await authorizeUser(req, "metrics.read", { sessionOnly: true, rateLimitMax: 30, rateLimitWindowMs: 60_000 });
  if (!a.ok) return a.response;

  try {
    const snapshot = await getMetricsSnapshot();
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    logInternal("metrics.read", e);
    return jerr("METRICS_FAIL", "Failed to load metrics", 500);
  }
}
