"use client";

import { useState } from "react";

type Combinator = "AND" | "OR";

type Op =
  | "eq" | "ne" | "gt" | "lt" | "gte" | "lte"
  | "contains" | "not_contains" | "starts_with" | "ends_with"
  | "in" | "between" | "is_null" | "is_not_null";

type ValueMode = "single" | "double" | "list" | "none";

const OPS: { value: Op; label: string; mode: ValueMode }[] = [
  { value: "eq", label: "=", mode: "single" },
  { value: "ne", label: "≠", mode: "single" },
  { value: "gt", label: ">", mode: "single" },
  { value: "lt", label: "<", mode: "single" },
  { value: "gte", label: "≥", mode: "single" },
  { value: "lte", label: "≤", mode: "single" },
  { value: "contains", label: "contains", mode: "single" },
  { value: "not_contains", label: "not contains", mode: "single" },
  { value: "starts_with", label: "starts with", mode: "single" },
  { value: "ends_with", label: "ends with", mode: "single" },
  { value: "in", label: "in (a,b,c)", mode: "list" },
  { value: "between", label: "between", mode: "double" },
  { value: "is_null", label: "is null", mode: "none" },
  { value: "is_not_null", label: "is not null", mode: "none" }
];

function opMode(op: Op): ValueMode {
  return OPS.find((o) => o.value === op)?.mode ?? "single";
}

type Condition = { column: string; op: Op; value: string; value2: string };
type Group = { combinator: Combinator; conditions: Condition[] };

interface SearchResult {
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdvancedSearchProps {
  connectionId: string;
  database: string;
  table: string;
  columns: { name: string }[];
  shareToken?: string;
}

const PAGE = 50;

export function AdvancedSearch({ connectionId, database, table, columns, shareToken }: AdvancedSearchProps) {
  const firstCol = columns[0]?.name ?? "";
  const newCondition = (): Condition => ({ column: firstCol, op: "eq", value: "", value2: "" });
  const newGroup = (): Group => ({ combinator: "AND", conditions: [newCondition()] });

  const [topCombinator, setTopCombinator] = useState<Combinator>("AND");
  const [groups, setGroups] = useState<Group[]>([newGroup()]);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateGroup(gi: number, patch: Partial<Group>) {
    setGroups((gs) => gs.map((g, i) => (i === gi ? { ...g, ...patch } : g)));
  }
  function updateCondition(gi: number, ci: number, patch: Partial<Condition>) {
    setGroups((gs) =>
      gs.map((g, i) =>
        i === gi ? { ...g, conditions: g.conditions.map((c, j) => (j === ci ? { ...c, ...patch } : c)) } : g
      )
    );
  }
  function addCondition(gi: number) {
    setGroups((gs) => gs.map((g, i) => (i === gi ? { ...g, conditions: [...g.conditions, newCondition()] } : g)));
  }
  function removeCondition(gi: number, ci: number) {
    setGroups((gs) =>
      gs.map((g, i) =>
        i === gi ? { ...g, conditions: g.conditions.filter((_, j) => j !== ci) } : g
      ).filter((g) => g.conditions.length > 0)
    );
  }
  function addGroup() {
    setGroups((gs) => [...gs, newGroup()]);
  }
  function removeGroup(gi: number) {
    setGroups((gs) => (gs.length > 1 ? gs.filter((_, i) => i !== gi) : gs));
  }

  function buildPayload(off: number) {
    return {
      database,
      table,
      limit: PAGE,
      offset: off,
      search: {
        combinator: topCombinator,
        groups: groups.map((g) => ({
          combinator: g.combinator,
          conditions: g.conditions.map((c) => {
            const mode = opMode(c.op);
            const cond: Record<string, string> = { column: c.column, op: c.op };
            if (mode !== "none") cond.value = c.value;
            if (mode === "double") cond.value2 = c.value2;
            return cond;
          })
        }))
      }
    };
  }

  async function runSearch(off: number) {
    setLoading(true);
    setError(null);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (shareToken) headers["x-share-token"] = shareToken;
      const res = await fetch(`/api/db/${connectionId}/search`, {
        method: "POST",
        headers,
        body: JSON.stringify(buildPayload(off))
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error?.message ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as SearchResult;
      setResult(data);
      setOffset(off);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }

  const totalPages = result ? Math.max(1, Math.ceil(result.total / PAGE)) : 1;
  const currentPage = Math.floor(offset / PAGE) + 1;

  return (
    <div className="flex flex-col h-full">
      {/* Builder */}
      <div className="border-b bg-white p-4 space-y-3 overflow-auto" style={{ maxHeight: "45%" }}>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-xs uppercase text-zinc-500">Match</span>
          <select
            className="rounded-lg border p-1 text-xs"
            value={topCombinator}
            onChange={(e) => setTopCombinator(e.target.value as Combinator)}
          >
            <option value="AND">ALL groups (AND)</option>
            <option value="OR">ANY group (OR)</option>
          </select>
        </div>

        {groups.map((g, gi) => (
          <div key={gi} className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs">
                <span className="uppercase text-zinc-500">Group {gi + 1} — match</span>
                <select
                  className="rounded-lg border p-1"
                  value={g.combinator}
                  onChange={(e) => updateGroup(gi, { combinator: e.target.value as Combinator })}
                >
                  <option value="AND">all (AND)</option>
                  <option value="OR">any (OR)</option>
                </select>
              </div>
              {groups.length > 1 && (
                <button onClick={() => removeGroup(gi)} className="text-xs text-red-600 hover:underline">
                  Remove group
                </button>
              )}
            </div>

            {g.conditions.map((c, ci) => {
              const mode = opMode(c.op);
              return (
                <div key={ci} className="flex items-center gap-2 flex-wrap text-sm">
                  <select
                    className="rounded-lg border p-1 text-xs min-w-32"
                    value={c.column}
                    onChange={(e) => updateCondition(gi, ci, { column: e.target.value })}
                  >
                    {columns.map((col) => (
                      <option key={col.name} value={col.name}>{col.name}</option>
                    ))}
                  </select>
                  <select
                    className="rounded-lg border p-1 text-xs"
                    value={c.op}
                    onChange={(e) => updateCondition(gi, ci, { op: e.target.value as Op })}
                  >
                    {OPS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  {mode !== "none" && (
                    <input
                      type="text"
                      className="rounded-lg border p-1 text-xs"
                      placeholder={mode === "list" ? "a, b, c" : "value"}
                      value={c.value}
                      onChange={(e) => updateCondition(gi, ci, { value: e.target.value })}
                    />
                  )}
                  {mode === "double" && (
                    <>
                      <span className="text-xs text-zinc-400">and</span>
                      <input
                        type="text"
                        className="rounded-lg border p-1 text-xs"
                        placeholder="value2"
                        value={c.value2}
                        onChange={(e) => updateCondition(gi, ci, { value2: e.target.value })}
                      />
                    </>
                  )}
                  <button onClick={() => removeCondition(gi, ci)} className="text-xs text-zinc-400 hover:text-red-600" title="Remove condition">
                    ✕
                  </button>
                </div>
              );
            })}

            <button onClick={() => addCondition(gi)} className="text-xs text-blue-600 hover:underline">
              + Add condition
            </button>
          </div>
        ))}

        <div className="flex items-center gap-2">
          <button onClick={addGroup} className="text-xs px-3 py-1 rounded-lg border bg-white hover:bg-zinc-50">
            + Add group
          </button>
          <button
            onClick={() => runSearch(0)}
            disabled={loading}
            className="text-sm px-4 py-1.5 rounded-lg border bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? "Searching…" : "Search"}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border-b border-red-200 text-sm text-red-700">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="px-4 py-2 bg-zinc-50 border-b text-xs text-zinc-500">
            {result.total.toLocaleString()} match{result.total !== 1 ? "es" : ""}
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            {result.rows.length === 0 ? (
              <div className="flex items-center justify-center h-full text-sm text-zinc-500">No matches</div>
            ) : (
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-zinc-100 sticky top-0">
                    {result.columns.map((col) => (
                      <th key={col} className="border border-zinc-200 px-3 py-2 text-left text-xs uppercase text-zinc-600 bg-zinc-50">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, idx) => (
                    <tr key={idx} className="hover:bg-zinc-50 border-b border-zinc-200">
                      {result.columns.map((col) => (
                        <td key={col} className="border border-zinc-200 px-3 py-1.5 text-xs text-zinc-700 font-mono whitespace-pre-wrap break-words max-w-96">
                          {formatValue(row[col])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {result.total > PAGE && (
            <div className="border-t bg-white px-4 py-2 flex items-center justify-between text-sm">
              <span className="text-zinc-500">Page {currentPage} / {totalPages}</span>
              <div className="flex gap-2">
                <button disabled={offset === 0 || loading} onClick={() => runSearch(Math.max(0, offset - PAGE))} className="px-3 py-1 rounded-xl border disabled:opacity-40">
                  ← Prev
                </button>
                <button disabled={offset + PAGE >= result.total || loading} onClick={() => runSearch(offset + PAGE)} className="px-3 py-1 rounded-xl border disabled:opacity-40">
                  Next →
                </button>
              </div>
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
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
