/**
 * AI SQL Assistant — turns a natural-language question into a read-only SQL query,
 * grounded in the connection's live schema.
 *
 * Provider-agnostic: talks to any OpenAI-compatible /chat/completions endpoint
 * (DeepSeek, FPT Cloud, OpenAI, local vLLM/Ollama, ...). Configure via env:
 *   AI_SQL_BASE_URL   e.g. https://api.deepseek.com  (or the FPT Cloud endpoint)
 *   AI_SQL_API_KEY    the provider key
 *   AI_SQL_MODEL      e.g. deepseek-chat   (default: deepseek-chat)
 *
 * Safety: the model is instructed to produce SELECT-only SQL, and every result is
 * re-checked with the same validateSql() guard the SQL editor uses before the query
 * is ever allowed near the database. The model's output is advice, not authority.
 */
import type { DriverType } from "@/lib/connections/dbConnector";
import { validateSql } from "@/lib/db-api/sqlValidator";

export type SchemaTable = { name: string; columns: { name: string; dataType: string }[] };

export type AiSqlResult = {
  sql: string;
  explanation: string;
  warnings: string[];
};

function baseUrl(): string {
  return (process.env.AI_SQL_BASE_URL || "").replace(/\/+$/, "");
}
function apiKey(): string {
  return process.env.AI_SQL_API_KEY || "";
}
function model(): string {
  return process.env.AI_SQL_MODEL || "deepseek-chat";
}

export function isAiConfigured(): boolean {
  return !!baseUrl() && !!apiKey();
}

const MAX_SCHEMA_TABLES = 60;
const MAX_COLS_PER_TABLE = 40;
const REQUEST_TIMEOUT_MS = 30_000;

function dialectName(driver: DriverType): string {
  if (driver === "mysql") return "MySQL";
  if (driver === "postgresql") return "PostgreSQL";
  if (driver === "mssql") return "SQL Server (T-SQL)";
  return String(driver);
}

/** Render the schema compactly so it fits the context without wasting tokens. */
function renderSchema(tables: SchemaTable[]): string {
  return tables
    .slice(0, MAX_SCHEMA_TABLES)
    .map((t) => {
      const cols = t.columns
        .slice(0, MAX_COLS_PER_TABLE)
        .map((c) => `${c.name} ${c.dataType}`)
        .join(", ");
      return `- ${t.name}(${cols})`;
    })
    .join("\n");
}

/** Pull a JSON object out of a model reply, tolerating ```json fences / prose. */
function extractJson(text: string): { sql?: unknown; explanation?: unknown; warnings?: unknown } {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Last resort: grab the first {...} span.
    const brace = candidate.match(/\{[\s\S]*\}/);
    if (brace) return JSON.parse(brace[0]);
    throw new Error("Model returned malformed JSON");
  }
}

/**
 * Generate a read-only SQL query from a natural-language prompt.
 * Throws on configuration/transport errors; returns a validation error string in
 * `warnings` + empty `sql` when the model produced something non-read-only.
 */
export async function generateSql(opts: {
  prompt: string;
  driver: DriverType;
  database: string;
  tables: SchemaTable[];
}): Promise<AiSqlResult> {
  const system =
    `You are an expert ${dialectName(opts.driver)} analyst. Translate the user's request into ONE ` +
    `read-only SQL query for the database "${opts.database}".\n` +
    `Rules:\n` +
    `- ${dialectName(opts.driver)} dialect and quoting only.\n` +
    `- READ-ONLY: SELECT / WITH / EXPLAIN only. Never INSERT, UPDATE, DELETE, or DDL.\n` +
    `- Use only tables and columns from the provided schema; do not invent names.\n` +
    `- Prefer explicit column lists over SELECT * when the intent is specific.\n` +
    `- Add a sensible LIMIT (e.g. 100) unless the user asks for an aggregate or a specific count.\n` +
    `- If the request is ambiguous, return your best attempt and note the assumption in warnings.\n\n` +
    `Reply with ONLY a JSON object of this exact shape (no prose, no code fences):\n` +
    `{"sql": "<one read-only SQL statement>", "explanation": "<1-2 sentences>", "warnings": ["<caveats, or empty>"]}\n\n` +
    `Schema:\n${renderSchema(opts.tables)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey()}`
      },
      body: JSON.stringify({
        model: model(),
        messages: [
          { role: "system", content: system },
          { role: "user", content: opts.prompt }
        ],
        // DeepSeek / OpenAI-compatible JSON mode. Harmless prompt-level fallback
        // is in place for servers that ignore this field.
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 1500,
        stream: false
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`AI provider ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI provider returned no content");

  const parsed = extractJson(content);
  const sql = typeof parsed.sql === "string" ? parsed.sql.trim() : "";
  const explanation = typeof parsed.explanation === "string" ? parsed.explanation : "";
  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((w): w is string => typeof w === "string")
    : [];

  // Defence in depth: reject anything that isn't read-only, regardless of the model.
  const check = validateSql(sql);
  if (!check.ok) {
    return { sql: "", explanation, warnings: [...warnings, `Rejected generated SQL: ${check.error}`] };
  }

  return { sql, explanation, warnings };
}
