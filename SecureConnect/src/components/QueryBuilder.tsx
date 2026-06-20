"use client";

import { useState, useMemo } from "react";

export type FilterOp = "eq" | "ne" | "contains" | "gt" | "lt" | "gte" | "lte" | "in" | "nin" | "between";

export interface FilterItem {
  id: string;
  column: string;
  op: FilterOp;
  value: string;
  value2?: string;
}

export interface QueryBuilderProps {
  columns: string[];
  onApply: (filters: FilterItem[]) => void;
  onClose: () => void;
  initialFilters?: FilterItem[];
}

const OPERATORS: Record<FilterOp, string> = {
  eq: "=",
  ne: "≠",
  contains: "⊃",
  gt: ">",
  lt: "<",
  gte: "≥",
  lte: "≤",
  in: "IN",
  nin: "NOT IN",
  between: "BETWEEN"
};

export function QueryBuilder({ columns, onApply, onClose, initialFilters = [] }: QueryBuilderProps) {
  const [filters, setFilters] = useState<FilterItem[]>(initialFilters.length > 0 ? initialFilters : []);
  const [logic, setLogic] = useState<"AND" | "OR">("AND");

  function addFilter() {
    setFilters((prev) => [
      ...prev,
      { id: Math.random().toString(36), column: columns[0] || "", op: "eq", value: "" }
    ]);
  }

  function removeFilter(id: string) {
    setFilters((prev) => prev.filter((f) => f.id !== id));
  }

  function updateFilter(id: string, key: keyof FilterItem, val: string | FilterOp) {
    setFilters((prev) =>
      prev.map((f) =>
        f.id === id ? { ...f, [key]: val } : f
      )
    );
  }

  const sqlPreview = useMemo(() => {
    if (filters.length === 0) return "WHERE 1=1";
    return (
      "WHERE " +
      filters
        .map((f) => {
          if (f.op === "between" && f.value2) {
            return `${f.column} BETWEEN ${f.value} AND ${f.value2}`;
          }
          if (f.op === "in" || f.op === "nin") {
            const vals = f.value.split(",").map((v) => `'${v.trim()}'`).join(",");
            return `${f.column} ${f.op === "in" ? "IN" : "NOT IN"} (${vals})`;
          }
          const opStr = OPERATORS[f.op];
          return `${f.column} ${opStr} '${f.value}'`;
        })
        .join(` ${logic} `)
    );
  }, [filters, logic]);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">Advanced Query Builder</h2>
          <button
            onClick={onClose}
            className="text-sm px-3 py-1 rounded-xl border bg-white hover:bg-zinc-50"
          >
            Close
          </button>
        </header>

        <div className="flex-1 overflow-auto px-5 py-3 space-y-3">
          {filters.map((f, idx) => (
            <div key={f.id} className="flex items-end gap-2">
              {idx > 0 && (
                <select
                  value={logic}
                  onChange={(e) => setLogic(e.target.value as "AND" | "OR")}
                  className="rounded-lg border p-2 text-sm bg-white"
                >
                  <option value="AND">AND</option>
                  <option value="OR">OR</option>
                </select>
              )}
              <select
                value={f.column}
                onChange={(e) => updateFilter(f.id, "column", e.target.value)}
                className="rounded-lg border p-2 text-sm min-w-[120px] bg-white"
              >
                <option value="">— column —</option>
                {columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <select
                value={f.op}
                onChange={(e) => updateFilter(f.id, "op", e.target.value as FilterOp)}
                className="rounded-lg border p-2 text-sm min-w-[80px] bg-white"
              >
                {Object.entries(OPERATORS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={f.value}
                onChange={(e) => updateFilter(f.id, "value", e.target.value)}
                placeholder="value"
                className="rounded-lg border p-2 text-sm flex-1 bg-white"
                maxLength={1024}
              />
              {(f.op === "between") && (
                <>
                  <span className="text-sm text-zinc-500">and</span>
                  <input
                    type="text"
                    value={f.value2 || ""}
                    onChange={(e) => updateFilter(f.id, "value2", e.target.value)}
                    placeholder="value 2"
                    className="rounded-lg border p-2 text-sm min-w-[100px] bg-white"
                    maxLength={1024}
                  />
                </>
              )}
              <button
                onClick={() => removeFilter(f.id)}
                className="text-sm px-2 py-2 rounded-lg border bg-red-50 hover:bg-red-100 text-red-600"
              >
                ✕
              </button>
            </div>
          ))}

          {filters.length === 0 && (
            <div className="text-sm text-zinc-500 p-4 border border-dashed rounded-lg">
              No filters yet. Click "+ Add filter" to begin.
            </div>
          )}

          <div className="border-t pt-3">
            <div className="text-xs uppercase text-zinc-500 mb-2">SQL Preview</div>
            <div className="bg-zinc-900 text-zinc-100 p-3 rounded-lg font-mono text-xs overflow-x-auto">
              {sqlPreview}
            </div>
          </div>
        </div>

        <footer className="px-5 py-3 border-t flex items-center justify-between gap-2">
          <button
            onClick={addFilter}
            className="px-4 py-2 rounded-xl border bg-blue-50 text-blue-700 hover:bg-blue-100"
          >
            + Add filter
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl border bg-white hover:bg-zinc-50"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                onApply(filters);
                onClose();
              }}
              className="px-4 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-700"
            >
              Apply filters
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
