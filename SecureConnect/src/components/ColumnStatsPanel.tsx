"use client";

import { useEffect, useState } from "react";
import {
  fetchColumnStats,
  calculateNullPercentage,
  calculateDistinctPercentage,
  getTypeCategory,
  type ColumnStats,
} from "@/lib/columnStats";

interface ColumnStatsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  connectionId: string;
  database: string;
  table: string;
  column: string;
}

export function ColumnStatsPanel({
  isOpen,
  onClose,
  connectionId,
  database,
  table,
  column,
}: ColumnStatsPanelProps) {
  const [stats, setStats] = useState<ColumnStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setLoading(true);
      setError(null);
      fetchColumnStats(connectionId, database, table, column)
        .then(setStats)
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
    }
  }, [isOpen, connectionId, database, table, column]);

  if (!isOpen) return null;

  const nullPct = stats ? calculateNullPercentage(stats) : 0;
  const distinctPct = stats ? calculateDistinctPercentage(stats) : 0;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-[var(--bg-secondary)] rounded-lg shadow-xl w-full max-w-lg p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">
            Column: {column}
          </h2>
          <button
            onClick={onClose}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            ✕
          </button>
        </div>

        {loading && <div className="text-center py-4">Loading statistics...</div>}
        {error && <div className="text-red-600 py-4">Error: {error}</div>}

        {stats && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="p-3 bg-[var(--bg-tertiary)] rounded">
                <div className="text-xs text-[var(--text-tertiary)]">Total Rows</div>
                <div className="font-mono text-sm text-[var(--text-primary)]">
                  {stats.total.toLocaleString()}
                </div>
              </div>

              <div className="p-3 bg-[var(--bg-tertiary)] rounded">
                <div className="text-xs text-[var(--text-tertiary)]">Distinct Values</div>
                <div className="font-mono text-sm text-[var(--text-primary)]">
                  {stats.distinct.toLocaleString()}
                </div>
              </div>

              <div className="p-3 bg-[var(--bg-tertiary)] rounded">
                <div className="text-xs text-[var(--text-tertiary)]">Null Count</div>
                <div className="font-mono text-sm text-[var(--text-primary)]">
                  {stats.nulls.toLocaleString()}
                </div>
              </div>

              <div className="p-3 bg-[var(--bg-tertiary)] rounded">
                <div className="text-xs text-[var(--text-tertiary)]">Non-Null Count</div>
                <div className="font-mono text-sm text-[var(--text-primary)]">
                  {stats.nonNull.toLocaleString()}
                </div>
              </div>

              {stats.min && (
                <div className="p-3 bg-[var(--bg-tertiary)] rounded">
                  <div className="text-xs text-[var(--text-tertiary)]">Min</div>
                  <div className="font-mono text-sm text-[var(--text-primary)] truncate">
                    {stats.min}
                  </div>
                </div>
              )}

              {stats.max && (
                <div className="p-3 bg-[var(--bg-tertiary)] rounded">
                  <div className="text-xs text-[var(--text-tertiary)]">Max</div>
                  <div className="font-mono text-sm text-[var(--text-primary)] truncate">
                    {stats.max}
                  </div>
                </div>
              )}

              {stats.avg && (
                <div className="p-3 bg-[var(--bg-tertiary)] rounded">
                  <div className="text-xs text-[var(--text-tertiary)]">Average</div>
                  <div className="font-mono text-sm text-[var(--text-primary)]">
                    {stats.avg}
                  </div>
                </div>
              )}

              {stats.sum && (
                <div className="p-3 bg-[var(--bg-tertiary)] rounded">
                  <div className="text-xs text-[var(--text-tertiary)]">Sum</div>
                  <div className="font-mono text-sm text-[var(--text-primary)]">
                    {stats.sum}
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-[var(--text-tertiary)]">Null Distribution</span>
                  <span className="text-[var(--text-secondary)]">{nullPct.toFixed(2)}%</span>
                </div>
                <div className="w-full bg-[var(--bg-tertiary)] rounded h-2">
                  <div
                    className="bg-yellow-500 h-2 rounded transition-all"
                    style={{ width: `${Math.min(nullPct, 100)}%` }}
                  />
                </div>
              </div>

              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-[var(--text-tertiary)]">Cardinality</span>
                  <span className="text-[var(--text-secondary)]">{distinctPct.toFixed(2)}%</span>
                </div>
                <div className="w-full bg-[var(--bg-tertiary)] rounded h-2">
                  <div
                    className="bg-blue-500 h-2 rounded transition-all"
                    style={{ width: `${Math.min(distinctPct, 100)}%` }}
                  />
                </div>
              </div>
            </div>

            <div className="text-xs text-[var(--text-tertiary)] p-2 bg-[var(--bg-tertiary)] rounded">
              Numeric: <span className="font-mono">{stats.numeric ? "Yes" : "No"}</span>
            </div>
          </div>
        )}

        <div className="mt-6 text-right">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm bg-[var(--focus-ring)] text-white rounded hover:opacity-90"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
