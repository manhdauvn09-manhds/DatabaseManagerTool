"use client";

import { useEffect, useState } from "react";

export interface HealthPanelProps {
  connectionId: string;
  onLatency?: (ms: number) => void;
}

interface HealthStatus {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export function HealthPanel({ connectionId, onLatency }: HealthPanelProps) {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkHealth = async () => {
      setLoading(true);
      const t0 = Date.now();
      try {
        const res = await fetch(`/api/health?cid=${encodeURIComponent(connectionId)}`, {
          cache: "no-store"
        });
        const latencyMs = Date.now() - t0;
        if (res.ok) {
          setHealth({ ok: true, latencyMs });
          onLatency?.(latencyMs);
        } else {
          setHealth({ ok: false, latencyMs, error: `HTTP ${res.status}` });
        }
      } catch (e) {
        setHealth({ ok: false, error: e instanceof Error ? e.message : String(e) });
      } finally {
        setLoading(false);
      }
    };

    checkHealth();
    const interval = setInterval(checkHealth, 30000); // Check every 30s
    return () => clearInterval(interval);
  }, [connectionId, onLatency]);

  return (
    <div className="border dark:border-zinc-600 rounded-lg p-3 bg-white dark:bg-zinc-800">
      <div className="text-xs uppercase text-zinc-500 dark:text-zinc-400 mb-2 font-medium">Connection Health</div>
      {loading && !health && <div className="text-sm text-zinc-500 dark:text-zinc-400">Checking…</div>}
      {health && (
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full ${health.ok ? "bg-green-500" : "bg-red-500"}`} />
            <span className={health.ok ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}>
              {health.ok ? "Connected" : "Failed"}
            </span>
          </div>
          {health.latencyMs !== undefined && (
            <div className="text-zinc-600 dark:text-zinc-300">
              Latency: <strong>{health.latencyMs}ms</strong>
            </div>
          )}
          {health.error && (
            <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-2 rounded">
              {health.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
