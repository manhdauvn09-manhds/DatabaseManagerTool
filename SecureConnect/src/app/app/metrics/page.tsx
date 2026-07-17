"use client";

import { useCallback, useEffect, useState } from "react";

type ActionStat = {
  action: string;
  count: number;
  errors: number;
  avgMs: number;
  maxMs: number;
  errorRate: number;
};
type Snapshot = {
  since: string | null;
  backend: "redis" | "memory";
  totals: { count: number; errors: number; errorRate: number; avgMs: number };
  actions: ActionStat[];
  cache: { hits: number; misses: number; hitRate: number };
};

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export default function MetricsPage() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/metrics", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!auto) return;
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [auto, load]);

  return (
    <main className="min-h-screen p-6">
      <div className="max-w-5xl mx-auto">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Observability</h1>
            <p className="text-sm text-zinc-600">
              Request throughput, latency, error rate &amp; schema-cache efficiency.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm flex items-center gap-1">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
              Auto refresh (10s)
            </label>
            <button onClick={load} className="text-sm px-4 py-2 rounded-xl border bg-white hover:bg-zinc-50">
              Refresh
            </button>
            <a href="/app" className="text-sm px-4 py-2 rounded-xl border bg-white hover:bg-zinc-50">
              ← Back
            </a>
          </div>
        </header>

        {err && (
          <div className="mt-4 text-sm text-red-600 border border-red-200 bg-red-50 rounded-xl p-3">
            Không tải được metrics: {err}
          </div>
        )}

        {data && (
          <>
            <section className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-3">
              <Tile label="Total requests" value={data.totals.count.toLocaleString()} />
              <Tile label="Avg latency" value={`${data.totals.avgMs} ms`} />
              <Tile
                label="Error rate"
                value={pct(data.totals.errorRate)}
                tone={data.totals.errorRate > 0.05 ? "bad" : data.totals.errorRate > 0 ? "warn" : "ok"}
              />
              <Tile
                label="Cache hit rate"
                value={pct(data.cache.hitRate)}
                tone={data.cache.hitRate >= 0.5 ? "ok" : "warn"}
                sub={`${data.cache.hits} hits / ${data.cache.misses} misses`}
              />
            </section>

            <section className="mt-6 rounded-2xl bg-white border border-zinc-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b flex items-center justify-between">
                <h2 className="font-semibold">Per-action breakdown</h2>
                <span className="text-xs text-zinc-500">
                  backend: {data.backend} · since {data.since ? new Date(data.since).toLocaleString() : "—"}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-zinc-500 border-b">
                      <th className="px-5 py-2">Action</th>
                      <th className="px-5 py-2 text-right">Count</th>
                      <th className="px-5 py-2 text-right">Errors</th>
                      <th className="px-5 py-2 text-right">Error rate</th>
                      <th className="px-5 py-2 text-right">Avg ms</th>
                      <th className="px-5 py-2 text-right">Max ms</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.actions.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-5 py-6 text-center text-zinc-500">
                          Chưa có dữ liệu — thực hiện vài thao tác rồi refresh.
                        </td>
                      </tr>
                    )}
                    {data.actions.map((a) => (
                      <tr key={a.action} className="border-b last:border-0 hover:bg-zinc-50">
                        <td className="px-5 py-2 font-mono text-xs">{a.action}</td>
                        <td className="px-5 py-2 text-right">{a.count.toLocaleString()}</td>
                        <td className="px-5 py-2 text-right">{a.errors}</td>
                        <td className={`px-5 py-2 text-right ${a.errorRate > 0.05 ? "text-red-600" : ""}`}>{pct(a.errorRate)}</td>
                        <td className="px-5 py-2 text-right">{a.avgMs}</td>
                        <td className="px-5 py-2 text-right">{a.maxMs}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function Tile({ label, value, sub, tone = "neutral" }: { label: string; value: string; sub?: string; tone?: "ok" | "warn" | "bad" | "neutral" }) {
  const color =
    tone === "ok" ? "text-emerald-600" : tone === "warn" ? "text-amber-600" : tone === "bad" ? "text-red-600" : "text-zinc-900";
  return (
    <div className="rounded-2xl bg-white border border-zinc-200 shadow-sm p-4">
      <div className={`text-2xl font-semibold ${color}`}>{value}</div>
      <div className="text-xs text-zinc-500 mt-1">{label}</div>
      {sub && <div className="text-xs text-zinc-400 mt-0.5">{sub}</div>}
    </div>
  );
}
