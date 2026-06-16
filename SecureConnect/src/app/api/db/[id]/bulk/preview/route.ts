import { NextResponse } from "next/server";
import { authorize, jerr, logInternal } from "@/lib/db-api/route-helper";
import { withConnection } from "@/lib/connections/dbConnector";
import { bulkPreview } from "@/lib/connections/bulkMutate";
import { parseSearchQuery } from "@/lib/connections/searchBuilder";
import { maxAffectRows, type RowMap } from "@/lib/connections/mutate";
import { issueToken } from "@/lib/security/confirmTokens";
import { audit } from "@/lib/security/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32 * 1024;

// POST /api/db/:id/bulk/preview { action, database, table, search, set? }
// Previews how many rows a bulk UPDATE/DELETE would affect + issues a confirm token.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const a = await authorize(req, params.id, "db.bulk.preview", { rateLimitMax: 30, rateLimitWindowMs: 60_000 });
  if (!a.ok) return a.response;
  const { ctx } = a;

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return jerr("BODY_TOO_LARGE", "Payload too large", 413);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return jerr("BAD_REQUEST", "Invalid JSON", 400); }

  const { action, database, table, search, set } = body as {
    action?: "update" | "delete";
    database?: string;
    table?: string;
    search?: unknown;
    set?: RowMap;
  };
  if (!database || !table) return jerr("BAD_REQUEST", "Missing database/table", 400);
  if (action !== "update" && action !== "delete") return jerr("BAD_REQUEST", "Invalid action", 400);
  if (action === "update" && (!set || typeof set !== "object" || Object.keys(set).length === 0)) {
    return jerr("BAD_REQUEST", "update requires a non-empty set", 400);
  }

  let query;
  try { query = parseSearchQuery(search); }
  catch (e) { return jerr("SEARCH_INVALID", e instanceof Error ? e.message : "Invalid filter", 400); }

  const t0 = Date.now();
  try {
    const result = await withConnection(ctx.rec, async (q, c) => bulkPreview(q, c.driver, database, table, query, 5));
    // Bind the token to the EXACT operation (incl. parsed search + set).
    const payload = action === "update"
      ? { action: "bulk-update", connectionId: params.id, database, table, search: query, set }
      : { action: "bulk-delete", connectionId: params.id, database, table, search: query };
    const token = await issueToken(payload);

    audit({ action: "db.bulk.preview", email: ctx.email, ip: ctx.ip, host: ctx.rec.host, port: ctx.rec.port, dbType: ctx.rec.dbType, ok: true, ms: Date.now() - t0 });
    return new NextResponse(
      JSON.stringify({ token, total: result.total, sample: result.sample, columns: result.columns, cap: maxAffectRows() }, replacer),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    logInternal("db.bulk.preview", e);
    audit({ action: "db.bulk.preview", email: ctx.email, ip: ctx.ip, ok: false, errCode: "PREVIEW_FAIL", ms: Date.now() - t0 });
    const msg = e instanceof Error ? e.message : "Preview failed";
    const isValidation = /^(Invalid |WHERE clause|No columns)/i.test(msg);
    return jerr("PREVIEW_FAIL", isValidation ? msg : "Preview failed", isValidation ? 400 : 500);
  }
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Buffer || value instanceof Uint8Array) return `0x${Buffer.from(value).toString("hex")}`;
  return value;
}
