import { NextResponse } from "next/server";
import { authorize, jerr, logInternal } from "@/lib/db-api/route-helper";
import { withConnection } from "@/lib/connections/dbConnector";
import { serverInfo, tableStats } from "@/lib/connections/monitoring";
import { validateIdent } from "@/lib/connections/dbConnector";
import { audit } from "@/lib/security/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 25;

// GET /api/db/:id/monitor?database= — server version/uptime + (optional) per-table sizes.
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const a = await authorize(req, params.id, "db.monitor", { rateLimitMax: 30, rateLimitWindowMs: 60_000, allowShare: true });
  if (!a.ok) return a.response;
  const { ctx } = a;

  const database = new URL(req.url).searchParams.get("database") ?? "";
  if (database) {
    try { validateIdent(database, "database"); }
    catch { return jerr("BAD_REQUEST", "Invalid database", 400); }
  }

  const t0 = Date.now();
  try {
    const data = await withConnection(ctx.rec, async (q, c) => {
      const info = await serverInfo(q, c.driver);
      const tables = database ? await tableStats(q, c.driver, database) : [];
      return { info, tables };
    });
    audit({ action: "db.monitor", email: ctx.email, ip: ctx.ip, host: ctx.rec.host, port: ctx.rec.port, dbType: ctx.rec.dbType, ok: true, ms: Date.now() - t0 });
    return NextResponse.json({ server: data.info, tables: data.tables });
  } catch (e) {
    logInternal("db.monitor", e);
    audit({ action: "db.monitor", email: ctx.email, ip: ctx.ip, ok: false, errCode: "MONITOR_FAIL", ms: Date.now() - t0 });
    return jerr("MONITOR_FAIL", "Failed to load monitoring data", 500);
  }
}
