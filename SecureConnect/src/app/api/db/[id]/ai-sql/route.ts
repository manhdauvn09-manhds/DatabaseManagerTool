import { NextResponse } from "next/server";
import { authorize, jerr, logInternal } from "@/lib/db-api/route-helper";
import { withConnection } from "@/lib/connections/dbConnector";
import { listTables, listColumns } from "@/lib/connections/introspection";
import { validateIdent } from "@/lib/connections/dbConnector";
import { audit } from "@/lib/security/auditLog";
import { generateSql, isAiConfigured, type SchemaTable } from "@/lib/ai/sqlAssistant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_PROMPT = 2000;
const SCHEMA_TABLE_CAP = 40; // bound how many tables we introspect for context

// POST /api/db/:id/ai-sql  { database, prompt }  → { sql, explanation, warnings }
export async function POST(req: Request, { params }: { params: { id: string } }) {
  // Read-only feature, but it reads schema — allow share tokens, tight rate limit.
  const a = await authorize(req, params.id, "db.ai_sql", { rateLimitMax: 15, rateLimitWindowMs: 60_000, allowShare: true });
  if (!a.ok) return a.response;
  const { ctx } = a;

  if (!isAiConfigured()) {
    return jerr("AI_NOT_CONFIGURED", "AI SQL assistant is not enabled on this server (ANTHROPIC_API_KEY unset).", 503);
  }

  const raw = await req.text();
  if (raw.length > MAX_PROMPT + 500) return jerr("BODY_TOO_LARGE", "Prompt too large", 413);
  let body: { database?: string; prompt?: string };
  try { body = JSON.parse(raw); } catch { return jerr("BAD_REQUEST", "Invalid JSON", 400); }

  const database = body.database ?? "";
  const prompt = (body.prompt ?? "").trim();
  if (!database || !prompt) return jerr("BAD_REQUEST", "Missing 'database' or 'prompt'", 400);
  if (prompt.length > MAX_PROMPT) return jerr("BAD_REQUEST", `Prompt too long (max ${MAX_PROMPT} chars)`, 400);
  try { validateIdent(database, "database"); } catch { return jerr("BAD_REQUEST", "Invalid database", 400); }

  const t0 = Date.now();
  try {
    // Gather a compact schema snapshot (tables + columns) to ground the model.
    const tables: SchemaTable[] = await withConnection(ctx.rec, async (q, c) => {
      const names = (await listTables(q, c.driver, database)).slice(0, SCHEMA_TABLE_CAP);
      const out: SchemaTable[] = [];
      for (const name of names) {
        const cols = await listColumns(q, c.driver, database, name);
        out.push({ name, columns: cols.map((col) => ({ name: col.name, dataType: col.dataType })) });
      }
      return out;
    });

    const result = await generateSql({ prompt, driver: ctx.rec.dbType, database, tables });

    audit({ action: "db.ai_sql", email: ctx.email, ip: ctx.ip, host: ctx.rec.host, port: ctx.rec.port, dbType: ctx.rec.dbType, ok: true, ms: Date.now() - t0 });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    logInternal("db.ai_sql", e);
    audit({ action: "db.ai_sql", email: ctx.email, ip: ctx.ip, ok: false, errCode: "AI_FAIL", ms: Date.now() - t0 });
    return jerr("AI_FAIL", "Failed to generate SQL", 500);
  }
}
