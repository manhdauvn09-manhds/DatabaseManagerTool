import { authorize, jerr, logInternal } from "@/lib/db-api/route-helper";
import { withConnection } from "@/lib/connections/dbConnector";
import { fetchRowsPage, type OrderBy, type Filter, MAX_EXPORT_BATCH_ROWS } from "@/lib/connections/introspection";
import { parseFiltersParam } from "@/lib/db-api/parseFilters";
import { csvHeader, csvRowsChunk } from "@/lib/connections/exporters";
import { audit } from "@/lib/security/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Hard ceiling so a runaway export can't stream forever. Configurable.
const DEFAULT_MAX = 500_000;
const MAX_STREAM_ROWS = Math.max(1000, Number(process.env.MAX_STREAM_EXPORT_ROWS ?? DEFAULT_MAX));

/**
 * GET /api/db/:id/export/stream — streamed CSV export.
 *
 * Unlike /export (which buffers the whole result in memory and is effectively
 * capped at one page), this pages through the table in batches and streams CSV
 * chunks as they are produced. Memory stays flat regardless of table size, and
 * it can export far more rows. A single keep-alive DB connection is held for the
 * whole stream via withConnection.
 */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const a = await authorize(req, params.id, "db.export.stream", { rateLimitMax: 5, rateLimitWindowMs: 60_000, allowShare: true });
  if (!a.ok) return a.response;
  const { ctx } = a;

  const url = new URL(req.url);
  const database = url.searchParams.get("database") ?? "";
  const table = url.searchParams.get("table") ?? "";
  if (!database || !table) return jerr("BAD_REQUEST", "Missing 'database' or 'table'", 400);

  const requestedMax = Number(url.searchParams.get("max") ?? String(MAX_STREAM_ROWS));
  const maxRows = Number.isFinite(requestedMax) && requestedMax > 0 ? Math.min(requestedMax, MAX_STREAM_ROWS) : MAX_STREAM_ROWS;

  const sortCol = url.searchParams.get("sort");
  const sortDir = url.searchParams.get("dir") === "desc" ? "desc" : "asc";
  const orderBy: OrderBy | undefined = sortCol ? { column: sortCol, dir: sortDir } : undefined;
  let filters: Filter[];
  try {
    filters = parseFiltersParam(url.searchParams.get("filters"));
  } catch (e) {
    return jerr("BAD_REQUEST", e instanceof Error ? e.message : "Invalid filters", 400);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${database}_${table}_${ts}.csv`;
  const t0 = Date.now();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let emitted = 0;
      try {
        await withConnection(ctx.rec, async (q, c) => {
          let offset = 0;
          let headerSent = false;
          // Page until a short batch (end of data) or the safety ceiling.
          for (;;) {
            const remaining = maxRows - emitted;
            if (remaining <= 0) break;
            const batchSize = Math.min(MAX_EXPORT_BATCH_ROWS, remaining);
            const { columns, rows } = await fetchRowsPage(
              q, c.driver, database, table, batchSize, offset, orderBy, filters, MAX_EXPORT_BATCH_ROWS
            );
            if (!headerSent) {
              controller.enqueue(encoder.encode(csvHeader(columns)));
              headerSent = true;
            }
            if (rows.length === 0) break;
            controller.enqueue(encoder.encode(csvRowsChunk(columns, rows)));
            emitted += rows.length;
            offset += rows.length;
            if (rows.length < batchSize) break; // last (partial) page
          }
        });
        audit({ action: "db.export.stream", email: ctx.email, ip: ctx.ip, host: ctx.rec.host, port: ctx.rec.port, dbType: ctx.rec.dbType, ok: true, ms: Date.now() - t0 });
        controller.close();
      } catch (e) {
        logInternal("db.export.stream", e);
        audit({ action: "db.export.stream", email: ctx.email, ip: ctx.ip, ok: false, errCode: "EXPORT_FAIL", ms: Date.now() - t0 });
        // The stream has likely already started (200 + partial CSV); surface the
        // failure inline as a CSV comment so the download isn't silently truncated.
        try { controller.enqueue(encoder.encode(`\r\n# export failed after ${emitted} rows\r\n`)); } catch { /* ignore */ }
        controller.close();
      }
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no" // ask nginx not to buffer the stream
    }
  });
}
