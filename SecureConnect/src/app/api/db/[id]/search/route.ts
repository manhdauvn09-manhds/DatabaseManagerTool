import { NextResponse } from "next/server";
import { authorize, jerr, logInternal } from "@/lib/db-api/route-helper";
import { withConnection } from "@/lib/connections/dbConnector";
import { searchRows, parseSearchQuery } from "@/lib/connections/searchBuilder";
import type { OrderBy } from "@/lib/connections/introspection";
import { audit } from "@/lib/security/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const MAX_BODY_BYTES = 16 * 1024; // 16 KiB — search trees are small

// POST /api/db/:id/search — advanced filtered search (2-level AND/OR builder)
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const a = await authorize(req, params.id, "db.search", { rateLimitMax: 60, rateLimitWindowMs: 60_000, allowShare: true });
  if (!a.ok) return a.response;
  const { ctx } = a;

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    audit({ action: "db.search", email: ctx.email, ip: ctx.ip, ok: false, errCode: "BODY_TOO_LARGE" });
    return jerr("BODY_TOO_LARGE", "Search payload too large", 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jerr("BAD_REQUEST", "Invalid JSON", 400);
  }

  const { database, table, search, limit, offset, sort, dir } = body as {
    database?: string;
    table?: string;
    search?: unknown;
    limit?: number;
    offset?: number;
    sort?: string;
    dir?: string;
  };

  if (!database || !table) return jerr("BAD_REQUEST", "Missing database/table", 400);

  let query;
  try {
    query = parseSearchQuery(search);
  } catch (e) {
    audit({ action: "db.search", email: ctx.email, ip: ctx.ip, ok: false, errCode: "SEARCH_INVALID" });
    return jerr("SEARCH_INVALID", e instanceof Error ? e.message : "Invalid search", 400);
  }

  const lim = Number.isFinite(limit) ? Number(limit) : 50;
  const off = Number.isFinite(offset) ? Number(offset) : 0;
  const orderBy: OrderBy | undefined = sort ? { column: sort, dir: dir === "desc" ? "desc" : "asc" } : undefined;

  const t0 = Date.now();
  try {
    const data = await withConnection(ctx.rec, async (qf, c) =>
      searchRows(qf, c.driver, database, table, query, lim, off, orderBy)
    );
    audit({
      action: "db.search",
      email: ctx.email,
      ip: ctx.ip,
      host: ctx.rec.host,
      port: ctx.rec.port,
      dbType: ctx.rec.dbType,
      ok: true,
      ms: Date.now() - t0
    });
    // replacer — rows may contain BigInt/Date/Buffer (JSON.stringify throws on BigInt).
    return new NextResponse(
      JSON.stringify({ columns: data.columns, rows: data.rows, total: data.total, limit: lim, offset: off }, replacer),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    logInternal("db.search", e);
    audit({ action: "db.search", email: ctx.email, ip: ctx.ip, ok: false, errCode: "SEARCH_FAIL", ms: Date.now() - t0 });
    const msg = e instanceof Error ? e.message : "Search failed";
    // Validation errors (invalid identifier / op / caps) are safe to expose.
    const isValidation = /^(Invalid |Unsupported |'in'|Too many|search )/i.test(msg);
    return jerr("SEARCH_FAIL", isValidation ? msg : "Search failed", isValidation ? 400 : 500);
  }
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Buffer || value instanceof Uint8Array) return `0x${Buffer.from(value).toString("hex")}`;
  return value;
}
