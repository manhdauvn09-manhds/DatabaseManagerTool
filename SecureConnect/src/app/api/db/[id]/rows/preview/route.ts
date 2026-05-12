import { NextResponse } from "next/server";
import { authorize, jerr, logInternal } from "@/lib/db-api/route-helper";
import { withConnection } from "@/lib/connections/dbConnector";
import { listColumns } from "@/lib/connections/introspection";
import { previewMatch, whereHasPrimaryKey, type RowMap } from "@/lib/connections/mutate";
import { issueToken } from "@/lib/security/confirmTokens";
import { audit } from "@/lib/security/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const a = await authorize(req, params.id, "db.rows.preview", { rateLimitMax: 30, rateLimitWindowMs: 60_000 });
  if (!a.ok) return a.response;
  const { ctx } = a;

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return jerr("BODY_TOO_LARGE", "Payload too large", 413);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return jerr("BAD_REQUEST", "Invalid JSON", 400); }

  const { database, table, action, where, set } = body as {
    database?: string;
    table?: string;
    action?: "update" | "delete";
    where?: RowMap;
    set?: RowMap;
  };
  if (!database || !table || !action || !where || (action === "update" && !set)) {
    return jerr("BAD_REQUEST", "Missing database/table/action/where/set", 400);
  }
  if (action !== "update" && action !== "delete") return jerr("BAD_REQUEST", "Invalid action", 400);
  if (Object.keys(where).length === 0) return jerr("BAD_REQUEST", "WHERE clause is mandatory", 400);

  const t0 = Date.now();
  try {
    const result = await withConnection(ctx.rec, async (q, c) => {
      const cols = await listColumns(q, c.driver, database, table);
      const match = await previewMatch(q, c.driver, database, table, where);
      const hasPK = whereHasPrimaryKey(where, cols);
      return { ...match, hasPrimaryKey: hasPK };
    });

    // Token payload — used for hash-binding. The connectionId is included so a
    // token issued for one connection cannot be reused on another.
    const payload = action === "update"
      ? { action, connectionId: params.id, database, table, where, set }
      : { action, connectionId: params.id, database, table, where };

    const token = issueToken(payload);

    audit({
      action: "db.rows.preview",
      email: ctx.email,
      ip: ctx.ip,
      host: ctx.rec.host,
      port: ctx.rec.port,
      dbType: ctx.rec.dbType,
      ok: true,
      ms: Date.now() - t0
    });
    return NextResponse.json({
      token,
      total: result.total,
      sample: result.sample,
      columns: result.columns,
      hasPrimaryKey: result.hasPrimaryKey
    });
  } catch (e) {
    logInternal("db.rows.preview", e);
    audit({ action: "db.rows.preview", email: ctx.email, ip: ctx.ip, ok: false, errCode: "PREVIEW_FAIL", ms: Date.now() - t0 });
    const msg = e instanceof Error ? e.message : "Preview failed";
    const isValidation = /^(Invalid |No columns|WHERE clause)/i.test(msg);
    return jerr("PREVIEW_FAIL", isValidation ? msg : "Preview failed", isValidation ? 400 : 500);
  }
}
