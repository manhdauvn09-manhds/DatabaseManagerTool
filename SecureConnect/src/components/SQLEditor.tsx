"use client";

import { useState } from "react";

export interface SQLEditorProps {
  connectionId: string;
  shareToken?: string;
  onError?: (msg: string) => void;
}

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionTimeMs: number;
  isExplain?: boolean;
  limit: number;
}

export function SQLEditor({ connectionId, shareToken }: SQLEditorProps) {
  const [sql, setSql] = useState("SELECT * FROM ");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (shareToken) headers["x-share-token"] = shareToken;

  async function executeQuery() {
    if (!sql.trim()) {
      setError("Please enter SQL");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch(`/api/db/${connectionId}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ sql, limit: 1000 })
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }

      const data = await res.json() as QueryResult;
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Query failed");
    } finally {
      setLoading(false);
    }
  }

  async function executeExplain() {
    if (!sql.trim()) {
      setError("Please enter SQL");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch(`/api/db/${connectionId}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ sql, explainOnly: true })
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }

      const data = await res.json() as QueryResult;
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "EXPLAIN failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Editor */}
      <div className="flex-1 min-h-0 flex flex-col border-b bg-white">
        <div className="flex items-center justify-between px-4 py-3 border-b bg-zinc-50">
          <span className="text-xs font-semibold uppercase text-zinc-500">SQL Query</span>
          <div className="flex gap-2">
            <button
              onClick={executeExplain}
              disabled={loading}
              className="px-3 py-1 text-sm rounded-lg border bg-white hover:bg-zinc-50 disabled:opacity-50"
            >
              Explain
            </button>
            <button
              onClick={executeQuery}
              disabled={loading}
              className="px-3 py-1 text-sm rounded-lg border bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? "Running…" : "Execute"}
            </button>
          </div>
        </div>

        <textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          disabled={loading}
          placeholder="Enter your SQL query here. Only SELECT, EXPLAIN, WITH, SHOW are allowed."
          className="flex-1 p-4 font-mono text-sm resize-none focus:outline-none bg-zinc-50 text-zinc-900 placeholder-zinc-400"
          spellCheck="false"
        />

        <div className="px-4 py-2 bg-zinc-50 border-t text-xs text-zinc-500">
          💡 Tip: Use Explain to see the query plan. Results are limited to 1,000 rows.
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div className="p-4 bg-red-50 border-t border-red-200 text-sm text-red-700">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="flex-1 min-h-0 flex flex-col bg-white border-t overflow-hidden">
          <div className="px-4 py-3 bg-zinc-50 border-b flex items-center justify-between">
            <span className="text-xs font-semibold uppercase text-zinc-500">
              {result.isExplain ? "Explain Plan" : "Results"} · {result.rowCount} row{result.rowCount !== 1 ? "s" : ""} · {result.executionTimeMs}ms
            </span>
            {result.rowCount >= result.limit && (
              <span className="text-xs text-orange-600">⚠️ Limited to {result.limit} rows</span>
            )}
          </div>

          {result.rowCount === 0 ? (
            <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
              No rows returned
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-zinc-100 sticky top-0">
                    {result.columns.map((col) => (
                      <th key={col} className="border border-zinc-200 px-3 py-2 text-left font-semibold text-xs uppercase text-zinc-600 bg-zinc-50">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, idx) => (
                    <tr key={idx} className="hover:bg-zinc-50 border-b border-zinc-200">
                      {result.columns.map((col) => (
                        <td key={col} className="border border-zinc-200 px-3 py-2 text-xs text-zinc-700 font-mono whitespace-pre-wrap break-words max-w-96">
                          {formatValue(row[col])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  return String(v);
}
