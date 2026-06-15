import { NextResponse } from "next/server";
import { authorize, jerr, logInternal } from "@/lib/db-api/route-helper";
import { withConnection } from "@/lib/connections/dbConnector";
import { executeQuery } from "@/lib/connections/queryExecutor";
import { validateSql } from "@/lib/db-api/sqlValidator";
import { audit } from "@/lib/security/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 35;

const MAX_BODY_BYTES = 50 * 1024; // 50 KiB — large SQL files

// POST /api/db/:id/query — Execute read-only SQL
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const a = await authorize(req, params.id, "db.query", { rateLimitMax: 60, rateLimitWindowMs: 60_000, allowShare: true });
  if (!a.ok) return a.response;
  const { ctx } = a;

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    audit({ action: "db.query", email: ctx.email, ip: ctx.ip, ok: false, errCode: "BODY_TOO_LARGE" });
    return jerr("BODY_TOO_LARGE", "SQL too large", 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jerr("BAD_REQUEST", "Invalid JSON", 400);
  }

  const { sql, limit, explainOnly } = body as {
    sql?: string;
    limit?: number;
    explainOnly?: boolean;
  };

  if (!sql || typeof sql !== "string") {
    return jerr("BAD_REQUEST", "Missing 'sql' field", 400);
  }

  // Validate SQL
  const validation = validateSql(sql);
  if (!validation.ok) {
    audit({ action: "db.query", email: ctx.email, ip: ctx.ip, ok: false, errCode: "SQL_INVALID" });
    return jerr("SQL_INVALID", validation.error ?? "Invalid SQL", 400);
  }

  const finalSql = explainOnly && !validation.isExplain ? `EXPLAIN ${sql}` : sql;

  const t0 = Date.now();
  try {
    const result = await withConnection(ctx.rec, async (q, c) =>
      executeQuery(q, finalSql, c.driver, { limit: limit ?? 1000, timeout: 30000 })
    );

    audit({
      action: "db.query",
      email: ctx.email,
      ip: ctx.ip,
      host: ctx.rec.host,
      port: ctx.rec.port,
      dbType: ctx.rec.dbType,
      ok: true,
      ms: Date.now() - t0
    });

    // Use a replacer (not NextResponse.json) — rows may contain BigInt/Date/Buffer
    // which JSON.stringify cannot serialize natively (BigInt throws).
    return new NextResponse(
      JSON.stringify(
        {
          columns: result.columns,
          rows: result.rows,
          rowCount: result.rowCount,
          executionTimeMs: result.executionTimeMs,
          isExplain: result.isExplain,
          limit
        },
        replacer
      ),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    logInternal("db.query", e);
    audit({
      action: "db.query",
      email: ctx.email,
      ip: ctx.ip,
      ok: false,
      errCode: "QUERY_FAIL",
      ms: Date.now() - t0
    });

    const msg = e instanceof Error ? e.message : "Query failed";
    return jerr("QUERY_FAIL", msg, 500);
  }
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Buffer || value instanceof Uint8Array) return `0x${Buffer.from(value).toString("hex")}`;
  return value;
}
