import { NextResponse } from "next/server";
import { authorize, jerr, logInternal } from "@/lib/db-api/route-helper";
import { withConnection } from "@/lib/connections/dbConnector";
import { listRows } from "@/lib/connections/introspection";
import { audit } from "@/lib/security/auditLog";

export const runtime = "nodejs";
export const maxDuration = 20;

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const a = await authorize(req, params.id, "db.rows");
  if (!a.ok) return a.response;
  const { ctx } = a;
  const url = new URL(req.url);
  const database = url.searchParams.get("database") ?? "";
  const table = url.searchParams.get("table") ?? "";
  const limit = Number(url.searchParams.get("limit") ?? "100");
  const offset = Number(url.searchParams.get("offset") ?? "0");
  if (!database || !table) return jerr("BAD_REQUEST", "Missing 'database' or 'table' query param", 400);
  if (!Number.isFinite(limit) || !Number.isFinite(offset) || limit <= 0 || offset < 0) {
    return jerr("BAD_REQUEST", "Invalid limit/offset", 400);
  }
  const t0 = Date.now();
  try {
    const data = await withConnection(ctx.rec, async (q, c) => listRows(q, c.driver, database, table, limit, offset));
    audit({ action: "db.rows", email: ctx.email, ip: ctx.ip, host: ctx.rec.host, port: ctx.rec.port, dbType: ctx.rec.dbType, ok: true, ms: Date.now() - t0 });
    // Serialize values safely (BigInt/Date → string).
    return new NextResponse(
      JSON.stringify({ columns: data.columns, rows: data.rows, total: data.total, limit, offset }, replacer),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    logInternal("db.rows", e);
    audit({ action: "db.rows", email: ctx.email, ip: ctx.ip, ok: false, errCode: "QUERY_FAIL", ms: Date.now() - t0 });
    return jerr("QUERY_FAIL", "Failed to fetch rows", 500);
  }
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Buffer || value instanceof Uint8Array) return `0x${Buffer.from(value).toString("hex")}`;
  return value;
}
