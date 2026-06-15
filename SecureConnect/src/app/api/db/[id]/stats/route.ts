import { NextResponse } from "next/server";
import { authorize, jerr, logInternal } from "@/lib/db-api/route-helper";
import { withConnection } from "@/lib/connections/dbConnector";
import { listColumns } from "@/lib/connections/introspection";
import { columnStats, isNumericType } from "@/lib/connections/stats";
import { audit } from "@/lib/security/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 25;

// GET /api/db/:id/stats?database=&table=&column= — aggregate stats for one column.
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const a = await authorize(req, params.id, "db.stats", { rateLimitMax: 60, rateLimitWindowMs: 60_000, allowShare: true });
  if (!a.ok) return a.response;
  const { ctx } = a;

  const url = new URL(req.url);
  const database = url.searchParams.get("database") ?? "";
  const table = url.searchParams.get("table") ?? "";
  const column = url.searchParams.get("column") ?? "";
  if (!database || !table || !column) return jerr("BAD_REQUEST", "Missing database/table/column", 400);

  const t0 = Date.now();
  try {
    const stats = await withConnection(ctx.rec, async (q, c) => {
      const cols = await listColumns(q, c.driver, database, table);
      const meta = cols.find((x) => x.name === column);
      if (!meta) throw new Error(`Invalid column: ${column}`);
      return columnStats(q, c.driver, database, table, column, isNumericType(meta.dataType));
    });
    audit({ action: "db.stats", email: ctx.email, ip: ctx.ip, host: ctx.rec.host, port: ctx.rec.port, dbType: ctx.rec.dbType, ok: true, ms: Date.now() - t0 });
    return NextResponse.json({ column, stats });
  } catch (e) {
    logInternal("db.stats", e);
    audit({ action: "db.stats", email: ctx.email, ip: ctx.ip, ok: false, errCode: "STATS_FAIL", ms: Date.now() - t0 });
    const msg = e instanceof Error ? e.message : "Stats failed";
    const isValidation = /^Invalid /i.test(msg);
    return jerr("STATS_FAIL", isValidation ? msg : "Failed to compute stats", isValidation ? 400 : 500);
  }
}
