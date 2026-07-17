/**
 * AI SQL Assistant — turns a natural-language question into a read-only SQL query
 * using Claude, grounded in the connection's live schema.
 *
 * Safety: the model is instructed to produce SELECT-only SQL, and every result is
 * re-checked with the same validateSql() guard the SQL editor uses before the query
 * is ever allowed near the database. The model's output is advice, not authority.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { DriverType } from "@/lib/connections/dbConnector";
import { validateSql } from "@/lib/db-api/sqlValidator";

export type SchemaTable = { name: string; columns: { name: string; dataType: string }[] };

export type AiSqlResult = {
  sql: string;
  explanation: string;
  warnings: string[];
};

export function isAiConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

const MODEL = process.env.AI_SQL_MODEL || "claude-opus-4-8";
const MAX_SCHEMA_TABLES = 60;
const MAX_COLS_PER_TABLE = 40;

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

// JSON Schema for the structured response — guarantees a parseable shape.
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    sql: { type: "string", description: "A single read-only SQL statement (SELECT/WITH/EXPLAIN). No trailing semicolon required." },
    explanation: { type: "string", description: "One or two sentences explaining what the query returns." },
    warnings: { type: "array", items: { type: "string" }, description: "Any caveats: ambiguous columns, assumptions made, performance notes. Empty if none." }
  },
  required: ["sql", "explanation", "warnings"],
  additionalProperties: false
} as const;

/**
 * Generate a read-only SQL query from a natural-language prompt.
 * Throws on configuration/model errors; returns a validation error string in
 * `warnings` + empty `sql` when the model produced something non-read-only.
 */
export async function generateSql(opts: {
  prompt: string;
  driver: DriverType;
  database: string;
  tables: SchemaTable[];
}): Promise<AiSqlResult> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

  const system =
    `You are an expert ${dialectName(opts.driver)} analyst. Translate the user's request into ONE ` +
    `read-only SQL query for the database "${opts.database}".\n` +
    `Rules:\n` +
    `- ${dialectName(opts.driver)} dialect and quoting only.\n` +
    `- READ-ONLY: SELECT / WITH / EXPLAIN only. Never INSERT, UPDATE, DELETE, or DDL.\n` +
    `- Use only tables and columns from the provided schema; do not invent names.\n` +
    `- Prefer explicit column lists over SELECT * when the intent is specific.\n` +
    `- Add a sensible LIMIT (e.g. 100) unless the user asks for an aggregate or a specific count.\n` +
    `- If the request is ambiguous or cannot be answered from the schema, return your best attempt ` +
    `and note the assumption in warnings.\n\n` +
    `Schema:\n${renderSchema(opts.tables)}`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system,
    output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    messages: [{ role: "user", content: opts.prompt }]
  });

  const textBlock = message.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) throw new Error("Model returned no text output");

  let parsed: { sql?: unknown; explanation?: unknown; warnings?: unknown };
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    throw new Error("Model returned malformed JSON");
  }

  const sql = typeof parsed.sql === "string" ? parsed.sql.trim() : "";
  const explanation = typeof parsed.explanation === "string" ? parsed.explanation : "";
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.filter((w): w is string => typeof w === "string") : [];

  // Defence in depth: reject anything that isn't read-only, regardless of the model.
  const check = validateSql(sql);
  if (!check.ok) {
    return { sql: "", explanation, warnings: [...warnings, `Rejected generated SQL: ${check.error}`] };
  }

  return { sql, explanation, warnings };
}
