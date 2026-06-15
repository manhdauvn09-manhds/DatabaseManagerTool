import { NextResponse } from "next/server";
import { authorize, jerr, logInternal } from "@/lib/db-api/route-helper";
import { withConnection } from "@/lib/connections/dbConnector";
import { listColumns } from "@/lib/connections/introspection";
import { audit } from "@/lib/security/auditLog";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const a = await authorize(req, params.id, "db.columns", { allowShare: true });
  if (!a.ok) return a.response;
  const { ctx } = a;
  const url = new URL(req.url);
  const database = url.searchParams.get("database") ?? "";
  const table = url.searchParams.get("table") ?? "";
  if (!database || !table) return jerr("BAD_REQUEST", "Missing 'database' or 'table' query param", 400);
  const t0 = Date.now();
  try {
    const columns = await withConnection(ctx.rec, async (q, c) => listColumns(q, c.driver, database, table));
    audit({ action: "db.columns", email: ctx.email, ip: ctx.ip, host: ctx.rec.host, port: ctx.rec.port, dbType: ctx.rec.dbType, ok: true, ms: Date.now() - t0 });
    return NextResponse.json({ columns });
  } catch (e) {
    logInternal("db.columns", e);
    audit({ action: "db.columns", email: ctx.email, ip: ctx.ip, ok: false, errCode: "QUERY_FAIL", ms: Date.now() - t0 });
    return jerr("QUERY_FAIL", "Failed to describe table", 500);
  }
}
