/**
 * Read-only monitoring: server version/uptime + per-database table sizes & row
 * estimates. Driver-specific introspection; the database/schema is always passed
 * as a bound parameter (never interpolated).
 */
import { type DriverType, type QueryFn } from "./dbConnector";

export type ServerInfo = { version: string; uptimeSec: number | null };
export type TableStat = { table: string; rows: number; bytes: number };

function num(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function serverInfo(q: QueryFn, driver: DriverType): Promise<ServerInfo> {
  if (driver === "mysql") {
    const v = await q("SELECT VERSION() AS version");
    let uptimeSec: number | null = null;
    try {
      const u = await q("SHOW GLOBAL STATUS LIKE 'Uptime'");
      const row = u.rows[0] as Record<string, unknown> | undefined;
      if (row) uptimeSec = num(row.Value ?? row.value);
    } catch { /* ignore */ }
    return { version: String((v.rows[0] as Record<string, unknown>)?.version ?? "unknown"), uptimeSec };
  }
  if (driver === "postgresql") {
    const r = await q("SELECT version() AS version, EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time())) AS uptime");
    const row = (r.rows[0] ?? {}) as Record<string, unknown>;
    return { version: String(row.version ?? "unknown"), uptimeSec: row.uptime != null ? num(row.uptime) : null };
  }
  // mssql
  const r = await q("SELECT @@VERSION AS version, DATEDIFF(SECOND, sqlserver_start_time, GETDATE()) AS uptime FROM sys.dm_os_sys_info");
  const row = (r.rows[0] ?? {}) as Record<string, unknown>;
  return { version: String(row.version ?? "unknown"), uptimeSec: row.uptime != null ? num(row.uptime) : null };
}

const TOP_N = 100;

export async function tableStats(q: QueryFn, driver: DriverType, database: string): Promise<TableStat[]> {
  if (driver === "mysql") {
    const r = await q(
      "SELECT table_name AS tbl, table_rows AS rws, (data_length + index_length) AS bytes " +
      "FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' " +
      `ORDER BY (data_length + index_length) DESC LIMIT ${TOP_N}`,
      [database]
    );
    return r.rows.map((x) => ({ table: String((x as Record<string, unknown>).tbl), rows: num((x as Record<string, unknown>).rws), bytes: num((x as Record<string, unknown>).bytes) }));
  }
  if (driver === "postgresql") {
    const r = await q(
      "SELECT relname AS tbl, n_live_tup AS rws, pg_total_relation_size(relid) AS bytes " +
      `FROM pg_stat_user_tables WHERE schemaname = ? ORDER BY pg_total_relation_size(relid) DESC LIMIT ${TOP_N}`,
      [database]
    );
    return r.rows.map((x) => ({ table: String((x as Record<string, unknown>).tbl), rows: num((x as Record<string, unknown>).rws), bytes: num((x as Record<string, unknown>).bytes) }));
  }
  // mssql — schema-scoped row counts + allocated size
  const r = await q(
    "SELECT t.name AS tbl, SUM(p.rows) AS rws, SUM(a.total_pages) * 8 * 1024 AS bytes " +
    "FROM sys.tables t " +
    "JOIN sys.schemas s ON s.schema_id = t.schema_id " +
    "JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1) " +
    "JOIN sys.allocation_units a ON a.container_id = p.partition_id " +
    "WHERE s.name = ? " +
    "GROUP BY t.name " +
    `ORDER BY SUM(a.total_pages) DESC`,
    [database]
  );
  return r.rows.slice(0, TOP_N).map((x) => ({ table: String((x as Record<string, unknown>).tbl), rows: num((x as Record<string, unknown>).rws), bytes: num((x as Record<string, unknown>).bytes) }));
}
