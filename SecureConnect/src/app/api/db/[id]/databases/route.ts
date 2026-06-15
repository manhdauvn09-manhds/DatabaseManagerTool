import { NextResponse } from "next/server";
import { authorize, jerr, logInternal } from "@/lib/db-api/route-helper";
import { withConnection } from "@/lib/connections/dbConnector";
import { listDatabases } from "@/lib/connections/introspection";
import { audit } from "@/lib/security/auditLog";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const a = await authorize(req, params.id, "db.databases", { allowShare: true });
  if (!a.ok) return a.response;
  const { ctx } = a;
  const t0 = Date.now();
  try {
    const databases = await withConnection(ctx.rec, async (q, c) => listDatabases(q, c.driver));
    audit({ action: "db.databases", email: ctx.email, ip: ctx.ip, host: ctx.rec.host, port: ctx.rec.port, dbType: ctx.rec.dbType, ok: true, ms: Date.now() - t0 });
    return NextResponse.json({ databases });
  } catch (e) {
    logInternal("db.databases", e);
    audit({ action: "db.databases", email: ctx.email, ip: ctx.ip, ok: false, errCode: "QUERY_FAIL", ms: Date.now() - t0 });
    return jerr("QUERY_FAIL", "Failed to list databases", 500);
  }
}
