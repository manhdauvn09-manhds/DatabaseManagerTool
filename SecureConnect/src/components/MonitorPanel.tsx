"use client";

import { useCallback, useEffect, useState } from "react";

interface ServerInfo { version: string; uptimeSec: number | null }
interface TableStat { table: string; rows: number; bytes: number }
interface MonitorResp { server: ServerInfo; tables: TableStat[] }

export interface MonitorPanelProps {
  connectionId: string;
  database: string | null;
  shareToken?: string;
}

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtUptime(sec: number | null): string {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

export function MonitorPanel({ connectionId, database, shareToken }: MonitorPanelProps) {
  const [data, setData] = useState<MonitorResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = database ? `?database=${encodeURIComponent(database)}` : "";
      const res = await fetch(`/api/db/${connectionId}/monitor${qs}`, {
        cache: "no-store",
        headers: shareToken ? { "x-share-token": shareToken } : undefined
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error?.message ?? `HTTP ${res.status}`);
      }
      setData((await res.json()) as MonitorResp);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [connectionId, database, shareToken]);

  useEffect(() => { void load(); }, [load]);

  const maxBytes = data?.tables.reduce((m, t) => Math.max(m, t.bytes), 0) ?? 0;

  return (
    <div className="flex flex-col h-full overflow-auto p-4 gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase text-zinc-500">Monitoring</h3>
        <button onClick={load} disabled={loading} className="text-xs px-3 py-1 rounded-lg border bg-white hover:bg-zinc-50 disabled:opacity-50">
          {loading ? "Loading…" : "↻ Refresh"}
        </button>
      </div>

      {error && <div className="text-sm rounded-xl border border-red-200 bg-red-50 text-red-700 p-3">{error}</div>}

      {data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-xl border border-zinc-200 bg-white p-3">
              <div className="text-xs uppercase text-zinc-400">Server</div>
              <div className="text-sm font-mono break-words mt-1">{data.server.version}</div>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-white p-3">
              <div className="text-xs uppercase text-zinc-400">Uptime</div>
              <div className="text-lg font-semibold mt-1">{fmtUptime(data.server.uptimeSec)}</div>
            </div>
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white">
            <div className="px-3 py-2 border-b text-xs uppercase text-zinc-400">
              {database ? `Tables in ${database} (top by size)` : "Select a database to see table sizes"}
            </div>
            {database && data.tables.length === 0 && <div className="p-4 text-sm text-zinc-500">No tables.</div>}
            {data.tables.length > 0 && (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-zinc-500 border-b">
                    <th className="px-3 py-2">Table</th>
                    <th className="px-3 py-2 text-right">Rows (est.)</th>
                    <th className="px-3 py-2 text-right">Size</th>
                    <th className="px-3 py-2 w-32">&nbsp;</th>
                  </tr>
                </thead>
                <tbody>
                  {data.tables.map((t) => (
                    <tr key={t.table} className="border-b hover:bg-zinc-50">
                      <td className="px-3 py-1.5 font-medium">{t.table}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{t.rows.toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmtBytes(t.bytes)}</td>
                      <td className="px-3 py-1.5">
                        <div className="h-2 rounded bg-zinc-100 overflow-hidden">
                          <div className="h-full bg-blue-500" style={{ width: `${maxBytes ? Math.max(2, (t.bytes / maxBytes) * 100) : 0}%` }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
