"use client";

import { useEffect, useState } from "react";

interface ColumnStats {
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

export interface ColumnStatsModalProps {
  connectionId: string;
  database: string;
  table: string;
  column: string;
  shareToken?: string;
  onClose: () => void;
}

export function ColumnStatsModal({ connectionId, database, table, column, shareToken, onClose }: ColumnStatsModalProps) {
  const [stats, setStats] = useState<ColumnStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const qs = `?database=${encodeURIComponent(database)}&table=${encodeURIComponent(table)}&column=${encodeURIComponent(column)}`;
    fetch(`/api/db/${connectionId}/stats${qs}`, {
      cache: "no-store",
      headers: shareToken ? { "x-share-token": shareToken } : undefined
    })
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => ({})))?.error?.message ?? `HTTP ${r.status}`))))
      .then((d: { stats: ColumnStats }) => { if (!cancelled) setStats(d.stats); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Failed"); });
    return () => { cancelled = true; };
  }, [connectionId, database, table, column, shareToken]);

  const rows: [string, string][] = stats
    ? [
        ["Total rows", stats.total.toLocaleString()],
        ["Non-null", stats.nonNull.toLocaleString()],
        ["Null", stats.nulls.toLocaleString()],
        ["Distinct", stats.distinct.toLocaleString()],
        ["Min", stats.min ?? "—"],
        ["Max", stats.max ?? "—"],
        ...(stats.numeric ? ([["Average", stats.avg ?? "—"], ["Sum", stats.sum ?? "—"]] as [string, string][]) : [])
      ]
    : [];

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-3 border-b flex items-center justify-between">
          <div>
            <div className="text-xs text-zinc-500">{database} · {table}</div>
            <h2 className="text-base font-semibold">📊 {column}</h2>
          </div>
          <button onClick={onClose} className="text-sm px-3 py-1 rounded-xl border bg-white hover:bg-zinc-50">Close</button>
        </header>
        <div className="p-5">
          {error && <div className="text-sm rounded-xl border border-red-200 bg-red-50 text-red-700 p-3">{error}</div>}
          {!error && !stats && <div className="text-sm text-zinc-500">Computing…</div>}
          {stats && (
            <table className="w-full text-sm">
              <tbody>
                {rows.map(([k, v]) => (
                  <tr key={k} className="border-b last:border-0">
                    <td className="py-1.5 text-zinc-500">{k}</td>
                    <td className="py-1.5 text-right font-mono break-all">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
