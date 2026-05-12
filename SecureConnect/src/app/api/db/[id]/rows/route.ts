import { NextResponse } from "next/server";
import { authorize, jerr, logInternal } from "@/lib/db-api/route-helper";
import { withConnection } from "@/lib/connections/dbConnector";
import { listRows } from "@/lib/connections/introspection";
import { insertRow, type RowMap } from "@/lib/connections/mutate";
import { audit } from "@/lib/security/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const MAX_BODY_BYTES = 64 * 1024; // 64 KiB — covers reasonable insert payloads.

// -------------------- GET (browse rows) --------------------
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
    return new NextResponse(
      JSON.stringify({ columns: data.columns, rows: data.rows, total: data.total, limit, offset }, replacer),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    logInternal("db.rows.get", e);
    audit({ action: "db.rows", email: ctx.email, ip: ctx.ip, ok: false, errCode: "QUERY_FAIL", ms: Date.now() - t0 });
    return jerr("QUERY_FAIL", "Failed to fetch rows", 500);
  }
}

// -------------------- POST (insert 1 row) --------------------
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const a = await authorize(req, params.id, "db.rows.insert", { rateLimitMax: 30, rateLimitWindowMs: 60_000 });
  if (!a.ok) return a.response;
  const { ctx } = a;

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    audit({ action: "db.rows.insert", email: ctx.email, ip: ctx.ip, ok: false, errCode: "BODY_TOO_LARGE" });
    return jerr("BODY_TOO_LARGE", "Payload too large", 413);
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return jerr("BAD_REQUEST", "Invalid JSON", 400); }

  const { database, table, data } = body as { database?: string; table?: string; data?: RowMap };
  if (!database || !table || !data || typeof data !== "object") {
    return jerr("BAD_REQUEST", "Missing database/table/data", 400);
  }

  const t0 = Date.now();
  try {
    const result = await withConnection(ctx.rec, async (q, c) => insertRow(q, c.driver, database, table, data));
    audit({
      action: "db.rows.insert",
      email: ctx.email,
      ip: ctx.ip,
      host: ctx.rec.host,
      port: ctx.rec.port,
      dbType: ctx.rec.dbType,
      ok: true,
      ms: Date.now() - t0
    });
    return NextResponse.json({ inserted: result.inserted, insertId: result.insertId ?? null });
  } catch (e) {
    logInternal("db.rows.insert", e);
    audit({ action: "db.rows.insert", email: ctx.email, ip: ctx.ip, ok: false, errCode: "INSERT_FAIL", ms: Date.now() - t0 });
    const msg = e instanceof Error ? e.message : "Insert failed";
    // Validation errors (invalid identifier / missing columns) are safe to expose; driver
    // errors are masked but logged server-side.
    const isValidation = /^(Invalid |No columns|WHERE clause)/i.test(msg);
    return jerr("INSERT_FAIL", isValidation ? msg : "Insert failed", isValidation ? 400 : 500);
  }
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Buffer || value instanceof Uint8Array) return `0x${Buffer.from(value).toString("hex")}`;
  return value;
}
