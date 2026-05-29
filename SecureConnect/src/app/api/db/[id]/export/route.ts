import { NextResponse } from "next/server";
import { authorize, jerr, logInternal } from "@/lib/db-api/route-helper";
import { withConnection } from "@/lib/connections/dbConnector";
import { listRows, type OrderBy, type Filter } from "@/lib/connections/introspection";
import { parseFiltersParam } from "@/lib/db-api/parseFilters";
import { toCsv, toJson, toSqlInserts, contentType, fileExtension, type ExportFormat } from "@/lib/connections/exporters";
import { audit } from "@/lib/security/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_MAX = 10_000;
const MAX_EXPORT_ROWS = Math.max(100, Number(process.env.MAX_EXPORT_ROWS ?? DEFAULT_MAX));

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const a = await authorize(req, params.id, "db.export", { rateLimitMax: 10, rateLimitWindowMs: 60_000 });
  if (!a.ok) return a.response;
  const { ctx } = a;
  const url = new URL(req.url);
  const database = url.searchParams.get("database") ?? "";
  const table = url.searchParams.get("table") ?? "";
  const format = (url.searchParams.get("format") ?? "csv") as ExportFormat;
  const requested = Number(url.searchParams.get("limit") ?? String(MAX_EXPORT_ROWS));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0"));

  if (!database || !table) return jerr("BAD_REQUEST", "Missing 'database' or 'table'", 400);
  if (!["csv", "json", "sql"].includes(format)) return jerr("BAD_REQUEST", "format must be csv|json|sql", 400);
  if (!Number.isFinite(requested) || requested <= 0) return jerr("BAD_REQUEST", "Invalid limit", 400);
  const limit = Math.min(requested, MAX_EXPORT_ROWS);

  // Match the on-screen view: same optional sort + filters.
  const sortCol = url.searchParams.get("sort");
  const sortDir = url.searchParams.get("dir") === "desc" ? "desc" : "asc";
  const orderBy: OrderBy | undefined = sortCol ? { column: sortCol, dir: sortDir } : undefined;
  let filters: Filter[];
  try {
    filters = parseFiltersParam(url.searchParams.get("filters"));
  } catch (e) {
    return jerr("BAD_REQUEST", e instanceof Error ? e.message : "Invalid filters", 400);
  }

  const t0 = Date.now();
  try {
    const data = await withConnection(ctx.rec, async (q, c) => listRows(q, c.driver, database, table, limit, offset, orderBy, filters));
    let body: string;
    if (format === "csv") body = toCsv(data.columns, data.rows);
    else if (format === "json") body = toJson(data.rows);
    else body = toSqlInserts(ctx.rec.dbType, database, table, data.columns, data.rows);

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${database}_${table}_${ts}.${fileExtension(format)}`;
    audit({
      action: "db.export",
      email: ctx.email,
      ip: ctx.ip,
      host: ctx.rec.host,
      port: ctx.rec.port,
      dbType: ctx.rec.dbType,
      ok: true,
      ms: Date.now() - t0
    });
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": contentType(format),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store"
      }
    });
  } catch (e) {
    logInternal("db.export", e);
    audit({ action: "db.export", email: ctx.email, ip: ctx.ip, ok: false, errCode: "EXPORT_FAIL", ms: Date.now() - t0 });
    const msg = e instanceof Error ? e.message : "Export failed";
    const isValidation = /^(Invalid )/i.test(msg);
    return jerr("EXPORT_FAIL", isValidation ? msg : "Export failed", isValidation ? 400 : 500);
  }
}
