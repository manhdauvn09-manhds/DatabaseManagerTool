import { NextResponse } from "next/server";
import { authorize, jerr, logInternal } from "@/lib/db-api/route-helper";
import { withConnection } from "@/lib/connections/dbConnector";
import { executeBulkUpdate, executeBulkDelete } from "@/lib/connections/bulkMutate";
import { parseSearchQuery } from "@/lib/connections/searchBuilder";
import { type RowMap } from "@/lib/connections/mutate";
import { consumeToken } from "@/lib/security/confirmTokens";
import { audit } from "@/lib/security/auditLog";
import { writeBackup } from "@/lib/connections/backup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 25;

const MAX_BODY_BYTES = 32 * 1024;

// PUT /api/db/:id/bulk { database, table, search, set, token } — bulk UPDATE.
export async function PUT(req: Request, { params }: { params: { id: string } }) {
  const a = await authorize(req, params.id, "db.bulk.update", { rateLimitMax: 15, rateLimitWindowMs: 60_000 });
  if (!a.ok) return a.response;
  const { ctx } = a;

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return jerr("BODY_TOO_LARGE", "Payload too large", 413);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return jerr("BAD_REQUEST", "Invalid JSON", 400); }

  const { database, table, search, set, token } = body as {
    database?: string; table?: string; search?: unknown; set?: RowMap; token?: string;
  };
  if (!database || !table || !set || !token) return jerr("BAD_REQUEST", "Missing database/table/set/token", 400);
  if (typeof set !== "object" || Object.keys(set).length === 0) return jerr("BAD_REQUEST", "set must be non-empty", 400);

  let query;
  try { query = parseSearchQuery(search); }
  catch (e) { return jerr("SEARCH_INVALID", e instanceof Error ? e.message : "Invalid filter", 400); }

  // Token must match this EXACT operation (parsed search is canonical).
  const tk = await consumeToken(token, { action: "bulk-update", connectionId: params.id, database, table, search: query, set });
  if (!tk.ok) {
    audit({ action: "db.bulk.update", email: ctx.email, ip: ctx.ip, ok: false, errCode: `TOKEN_${tk.reason.toUpperCase()}` });
    return jerr("BAD_TOKEN", `Token ${tk.reason} — please preview again`, 400);
  }

  const t0 = Date.now();
  try {
    const result = await withConnection(ctx.rec, async (q, c) => executeBulkUpdate(q, c.driver, database, table, set, query));
    audit({ action: "db.bulk.update", email: ctx.email, ip: ctx.ip, host: ctx.rec.host, port: ctx.rec.port, dbType: ctx.rec.dbType, ok: true, ms: Date.now() - t0 });
    return NextResponse.json({ affected: result.affected });
  } catch (e) {
    logInternal("db.bulk.update", e);
    audit({ action: "db.bulk.update", email: ctx.email, ip: ctx.ip, ok: false, errCode: "UPDATE_FAIL", ms: Date.now() - t0 });
    const msg = e instanceof Error ? e.message : "Bulk update failed";
    const isValidation = /^(Invalid |No columns|WHERE clause|Operation affects)/i.test(msg);
    return jerr("UPDATE_FAIL", isValidation ? msg : "Bulk update failed", isValidation ? 400 : 500);
  }
}

// DELETE /api/db/:id/bulk { database, table, search, token } — bulk DELETE (+ optional backup).
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const a = await authorize(req, params.id, "db.bulk.delete", { rateLimitMax: 15, rateLimitWindowMs: 60_000 });
  if (!a.ok) return a.response;
  const { ctx } = a;

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return jerr("BODY_TOO_LARGE", "Payload too large", 413);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return jerr("BAD_REQUEST", "Invalid JSON", 400); }

  const { database, table, search, token } = body as {
    database?: string; table?: string; search?: unknown; token?: string;
  };
  if (!database || !table || !token) return jerr("BAD_REQUEST", "Missing database/table/token", 400);

  let query;
  try { query = parseSearchQuery(search); }
  catch (e) { return jerr("SEARCH_INVALID", e instanceof Error ? e.message : "Invalid filter", 400); }

  const tk = await consumeToken(token, { action: "bulk-delete", connectionId: params.id, database, table, search: query });
  if (!tk.ok) {
    audit({ action: "db.bulk.delete", email: ctx.email, ip: ctx.ip, ok: false, errCode: `TOKEN_${tk.reason.toUpperCase()}` });
    return jerr("BAD_TOKEN", `Token ${tk.reason} — please preview again`, 400);
  }

  const t0 = Date.now();
  try {
    const result = await withConnection(ctx.rec, async (q, c) => executeBulkDelete(q, c.driver, database, table, query));
    let backupPath: string | null = null;
    if (result.backup && result.backup.length > 0) {
      backupPath = await writeBackup({ email: ctx.email, connectionId: params.id, database, table, rows: result.backup })
        .catch((e) => { logInternal("db.bulk.delete.backup", e); return null; });
    }
    audit({ action: "db.bulk.delete", email: ctx.email, ip: ctx.ip, host: ctx.rec.host, port: ctx.rec.port, dbType: ctx.rec.dbType, ok: true, ms: Date.now() - t0 });
    return NextResponse.json({ affected: result.affected, backupPath });
  } catch (e) {
    logInternal("db.bulk.delete", e);
    audit({ action: "db.bulk.delete", email: ctx.email, ip: ctx.ip, ok: false, errCode: "DELETE_FAIL", ms: Date.now() - t0 });
    const msg = e instanceof Error ? e.message : "Bulk delete failed";
    const isValidation = /^(Invalid |WHERE clause|DELETE would remove)/i.test(msg);
    return jerr("DELETE_FAIL", isValidation ? msg : "Bulk delete failed", isValidation ? 400 : 500);
  }
}
