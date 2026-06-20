import { NextResponse } from "next/server";
import { authorize, jerr, logInternal } from "@/lib/db-api/route-helper";
import { withConnection } from "@/lib/connections/dbConnector";
import { listTables } from "@/lib/connections/introspection";
import { audit } from "@/lib/security/auditLog";
import { getTablesFromCache, setTablesToCache } from "@/lib/connections/schemaCache";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const a = await authorize(req, params.id, "db.tables");
  if (!a.ok) return a.response;
  const { ctx } = a;
  const database = new URL(req.url).searchParams.get("database") ?? "";
  if (!database) return jerr("BAD_REQUEST", "Missing 'database' query param", 400);

  // Check cache first
  const cached = await getTablesFromCache(params.id, database);
  if (cached) {
    return NextResponse.json({ tables: cached, cached: true });
  }

  const t0 = Date.now();
  try {
    const tables = await withConnection(ctx.rec, async (q, c) => listTables(q, c.driver, database));
    // Cache result for 5 minutes
    await setTablesToCache(params.id, database, tables);
    audit({ action: "db.tables", email: ctx.email, ip: ctx.ip, host: ctx.rec.host, port: ctx.rec.port, dbType: ctx.rec.dbType, ok: true, ms: Date.now() - t0 });
    return NextResponse.json({ tables, cached: false });
  } catch (e) {
    logInternal("db.tables", e);
    audit({ action: "db.tables", email: ctx.email, ip: ctx.ip, ok: false, errCode: "QUERY_FAIL", ms: Date.now() - t0 });
    return jerr("QUERY_FAIL", "Failed to list tables", 500);
  }
}
