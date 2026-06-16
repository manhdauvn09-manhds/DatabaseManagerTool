"use client";

import { useState } from "react";

interface PreviewResp {
  token: string;
  total: number;
  sample: Record<string, unknown>[];
  columns: string[];
  cap: number;
}

type SetItem = { column: string; value: string; isNull: boolean };

export interface BulkEditModalProps {
  connectionId: string;
  database: string;
  table: string;
  columns: { name: string }[];
  // The current Advanced-Search query object (combinator + groups).
  search: unknown;
  onClose: () => void;
  onDone: (message: string) => void;
}

export function BulkEditModal({ connectionId, database, table, columns, search, onClose, onDone }: BulkEditModalProps) {
  const [mode, setMode] = useState<"update" | "delete">("update");
  const [sets, setSets] = useState<SetItem[]>([{ column: columns[0]?.name ?? "", value: "", isNull: false }]);
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setItem(i: number, patch: Partial<SetItem>) {
    setSets((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  }
  function buildSet(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const s of sets) if (s.column) out[s.column] = s.isNull ? null : s.value;
    return out;
  }

  async function doPreview() {
    setBusy(true); setError(null); setPreview(null); setTokenInput("");
    try {
      const body = mode === "update"
        ? { action: "update", database, table, search, set: buildSet() }
        : { action: "delete", database, table, search };
      const res = await fetch(`/api/db/${connectionId}/bulk/preview`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b?.error?.message ?? `HTTP ${res.status}`); }
      setPreview(await res.json() as PreviewResp);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preview failed");
    } finally { setBusy(false); }
  }

  async function execute() {
    if (!preview) return;
    if (tokenInput.trim().toUpperCase() !== preview.token) { setError("Token does not match."); return; }
    setBusy(true); setError(null);
    try {
      const common = { database, table, search, token: preview.token };
      const res = await fetch(`/api/db/${connectionId}/bulk`, {
        method: mode === "update" ? "PUT" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "update" ? { ...common, set: buildSet() } : common)
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b?.error?.message ?? `HTTP ${res.status}`); }
      const r = await res.json() as { affected: number; backupPath?: string | null };
      onDone(`${mode === "update" ? "Updated" : "Deleted"} ${r.affected} row(s).${r.backupPath ? ` Backup: ${r.backupPath}` : ""}`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Execute failed");
    } finally { setBusy(false); }
  }

  const overCap = preview ? preview.total > preview.cap : false;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => !busy && onClose()}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-3 border-b">
          <div className="text-xs text-zinc-500">{database} · {table} · applies to the current search filter</div>
          <h2 className="text-base font-semibold">⚡ Bulk edit</h2>
        </header>

        <div className="px-5 py-3 border-b flex gap-1">
          <button onClick={() => { setMode("update"); setPreview(null); }} className={"px-3 py-1 rounded-lg text-sm border " + (mode === "update" ? "bg-amber-600 text-white" : "bg-white")}>Update</button>
          <button onClick={() => { setMode("delete"); setPreview(null); }} className={"px-3 py-1 rounded-lg text-sm border " + (mode === "delete" ? "bg-red-600 text-white" : "bg-white")}>Delete</button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-3 space-y-3 text-sm">
          {mode === "update" && (
            <div className="space-y-2">
              <div className="text-xs uppercase text-zinc-500">Set columns</div>
              {sets.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select className="rounded-lg border p-1 text-xs" value={s.column} onChange={(e) => setItem(i, { column: e.target.value })}>
                    {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                  </select>
                  <span className="text-zinc-400">=</span>
                  <input className="rounded-lg border p-1 text-xs flex-1 disabled:bg-zinc-100" placeholder="value" value={s.value} disabled={s.isNull} onChange={(e) => setItem(i, { value: e.target.value })} />
                  <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={s.isNull} onChange={(e) => setItem(i, { isNull: e.target.checked })} /> NULL</label>
                  {sets.length > 1 && <button onClick={() => setSets((x) => x.filter((_, j) => j !== i))} className="text-xs text-zinc-400 hover:text-red-600">✕</button>}
                </div>
              ))}
              <button onClick={() => setSets((x) => [...x, { column: columns[0]?.name ?? "", value: "", isNull: false }])} className="text-xs text-blue-600 hover:underline">+ Add column</button>
            </div>
          )}

          {!preview && (
            <button onClick={doPreview} disabled={busy} className="px-4 py-1.5 rounded-lg border bg-zinc-900 text-white text-sm disabled:opacity-50">
              {busy ? "Previewing…" : "Preview affected rows"}
            </button>
          )}

          {preview && (
            <>
              <div className={"rounded-xl border p-3 " + (overCap ? "border-red-300 bg-red-50" : "border-amber-300 bg-amber-50")}>
                <div><strong>{mode === "update" ? "Will UPDATE" : "Will DELETE"} {preview.total} row(s).</strong></div>
                {overCap && <div className="text-red-800 text-xs mt-1">⚠️ Exceeds cap ({preview.cap}). Refine the filter — execute will be refused.</div>}
                {preview.total === 0 && <div className="text-zinc-600 text-xs mt-1">No rows match.</div>}
              </div>
              <div>
                <div className="text-xs uppercase text-zinc-500 mb-1">Sample matched rows</div>
                <div className="rounded-xl border bg-zinc-50 p-2 max-h-40 overflow-auto text-xs"><pre>{JSON.stringify(preview.sample, null, 2)}</pre></div>
              </div>
              <div>
                <label className="text-sm">Type token to confirm: <code className="bg-zinc-900 text-white px-2 py-0.5 rounded font-mono">{preview.token}</code></label>
                <input className="mt-1 w-full rounded-xl border p-2 font-mono text-sm uppercase tracking-widest" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} maxLength={8} autoComplete="off" spellCheck={false} />
              </div>
            </>
          )}
        </div>

        {error && <div className="mx-5 mb-2 text-sm rounded-xl border border-red-200 bg-red-50 text-red-700 p-3">{error}</div>}

        <footer className="px-5 py-3 border-t flex items-center justify-between">
          <button onClick={onClose} disabled={busy} className="px-4 py-2 rounded-xl border bg-white hover:bg-zinc-50 disabled:opacity-50">Cancel</button>
          {preview && (
            <button
              onClick={execute}
              disabled={busy || overCap || preview.total === 0 || tokenInput.length < 8}
              className={"px-4 py-2 rounded-xl text-white disabled:opacity-50 " + (mode === "update" ? "bg-amber-700 hover:bg-amber-800" : "bg-red-700 hover:bg-red-800")}
            >
              {busy ? "Working…" : mode === "update" ? "Confirm bulk update" : "Confirm bulk delete"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
