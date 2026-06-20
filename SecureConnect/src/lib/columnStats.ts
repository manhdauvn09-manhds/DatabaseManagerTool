export interface ColumnStats {
  column: string;
  total: number;
  nonNull: number;
  nulls: number;
  distinct: number;
  min: string | null;
  max: string | null;
  avg: string | null;
  sum: string | null;
  numeric: boolean;
}

interface StatsResponse {
  column: string;
  stats: ColumnStats;
}

export async function fetchColumnStats(
  connectionId: string,
  database: string,
  table: string,
  column: string
): Promise<ColumnStats> {
  const params = new URLSearchParams({
    database,
    table,
    column,
  });

  const res = await fetch(`/api/db/${connectionId}/column-stats?${params}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch column stats: ${res.statusText}`);
  }

  const data = (await res.json()) as StatsResponse;
  return data.stats;
}

export function calculateNullPercentage(stats: ColumnStats): number {
  return stats.total > 0 ? (stats.nulls / stats.total) * 100 : 0;
}

export function calculateDistinctPercentage(stats: ColumnStats): number {
  return stats.total > 0 ? (stats.distinct / stats.total) * 100 : 0;
}

export function getTypeCategory(dataType: string): string {
  const type = dataType.toLowerCase();
  if (
    type.includes("char") ||
    type.includes("text") ||
    type.includes("varchar")
  ) {
    return "string";
  }
  if (type.includes("int") || type.includes("bigint") || type.includes("smallint")) {
    return "integer";
  }
  if (
    type.includes("float") ||
    type.includes("double") ||
    type.includes("decimal") ||
    type.includes("numeric")
  ) {
    return "numeric";
  }
  if (type.includes("date") || type.includes("time")) {
    return "temporal";
  }
  if (type.includes("bool") || type.includes("bit")) {
    return "boolean";
  }
  return "other";
}
