"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signOut } from "next-auth/react";

type ColumnInfo = {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  default: string | null;
};

type RowsResp = { columns: string[]; rows: Record<string, unknown>[]; total: number; limit: number; offset: number };

function ExplorerInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const cid = sp.get("cid") ?? "";

  const [databases, setDatabases] = useState<string[]>([]);
  const [tablesByDb, setTablesByDb] = useState<Record<string, string[]>>({});
  const [expandedDb, setExpandedDb] = useState<string | null>(null);
  const [selectedDb, setSelectedDb] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);

  const [view, setView] = useState<"columns" | "data">("data");
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [rowsData, setRowsData] = useState<RowsResp | null>(null);

  const [limit] = useState(50);
  const [offset, setOffset] = useState(0);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Insert row modal state
  const [insertOpen, setInsertOpen] = useState(false);
  const [insertValues, setInsertValues] = useState<Record<string, string>>({});
  const [insertNulls, setInsertNulls] = useState<Record<string, boolean>>({});
  const [inserting, setInserting] = useState(false);
  const [insertError, setInsertError] = useState<string | null>(null);

  // Refresh trigger — incremented after mutations to refetch rows.
  const [refreshSeq, setRefreshSeq] = useState(0);

  // Redirect to /app if no cid.
  useEffect(() => {
    if (!cid) router.replace("/app");
  }, [cid, router]);

  const apiGet = useCallback(async <T,>(path: string): Promise<T> => {
    const res = await fetch(path, { cache: "no-store" });
    if (res.status === 404 || res.status === 401) {
      router.replace("/app");
      throw new Error("Connection expired. Please reconnect.");
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  }, [router]);

  const apiPost = useCallback(async <T,>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (res.status === 404 || res.status === 401) {
      router.replace("/app");
      throw new Error("Connection expired. Please reconnect.");
    }
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j?.error?.message ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  }, [router]);

  // 1. Load databases on mount.
  useEffect(() => {
    if (!cid) return;
    setLoading(true);
    setError(null);
    apiGet<{ databases: string[] }>(`/api/db/${cid}/databases`)
      .then((d) => setDatabases(d.databases))
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
  }, [cid, apiGet]);

  // 2. Expand a DB → load its tables.
  const toggleDb = useCallback(async (db: string) => {
    if (expandedDb === db) {
      setExpandedDb(null);
      return;
    }
    setExpandedDb(db);
    if (!tablesByDb[db]) {
      try {
        setError(null);
        const d = await apiGet<{ tables: string[] }>(`/api/db/${cid}/tables?database=${encodeURIComponent(db)}`);
        setTablesByDb((prev) => ({ ...prev, [db]: d.tables }));
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      }
    }
  }, [expandedDb, tablesByDb, apiGet, cid]);

  // 3. Select a table → load columns + first page of rows.
  const selectTable = useCallback(async (db: string, table: string) => {
    setSelectedDb(db);
    setSelectedTable(table);
    setOffset(0);
    setColumns([]);
    setRowsData(null);
    setError(null);
  }, []);

  // Load columns + rows when selection changes or pagination changes.
  useEffect(() => {
    if (!selectedDb || !selectedTable) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [cRes, rRes] = await Promise.all([
          apiGet<{ columns: ColumnInfo[] }>(`/api/db/${cid}/columns?database=${encodeURIComponent(selectedDb)}&table=${encodeURIComponent(selectedTable)}`),
          apiGet<RowsResp>(`/api/db/${cid}/rows?database=${encodeURIComponent(selectedDb)}&table=${encodeURIComponent(selectedTable)}&limit=${limit}&offset=${offset}`)
        ]);
        if (cancelled) return;
        setColumns(cRes.columns);
        setRowsData(rRes);
      } catch (e) {
        if (!cancelled) setError(String(e instanceof Error ? e.message : e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedDb, selectedTable, offset, limit, apiGet, cid, refreshSeq]);

  function openInsertModal() {
    const init: Record<string, string> = {};
    const nulls: Record<string, boolean> = {};
    columns.forEach((c) => {
      init[c.name] = "";
      nulls[c.name] = c.nullable && c.default === null;
    });
    setInsertValues(init);
    setInsertNulls(nulls);
    setInsertError(null);
    setInsertOpen(true);
  }

  async function submitInsert() {
    if (!selectedDb || !selectedTable) return;
    setInserting(true);
    setInsertError(null);
    try {
      const data: Record<string, string | null> = {};
      for (const c of columns) {
        if (insertNulls[c.name]) data[c.name] = null;
        else data[c.name] = insertValues[c.name];
      }
      await apiPost(`/api/db/${cid}/rows`, { database: selectedDb, table: selectedTable, data });
      setInsertOpen(false);
      setOffset(0);
      setRefreshSeq((n) => n + 1);
    } catch (e) {
      setInsertError(String(e instanceof Error ? e.message : e));
    } finally {
      setInserting(false);
    }
  }

  const totalPages = useMemo(() => rowsData ? Math.max(1, Math.ceil(rowsData.total / limit)) : 1, [rowsData, limit]);
  const currentPage = useMemo(() => Math.floor(offset / limit) + 1, [offset, limit]);

  function disconnect() {
    router.replace("/app");
  }

  if (!cid) return null;

  return (
    <main className="min-h-screen flex flex-col bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white px-5 py-3 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">DatabaseManager</h1>
          <p className="text-xs text-zinc-500">
            Connection: <code className="bg-zinc-100 px-1.5 py-0.5 rounded">{cid.slice(0, 8)}…</code>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={disconnect} className="text-sm px-3 py-1.5 rounded-xl border bg-white hover:bg-zinc-50">
            Disconnect
          </button>
          <button onClick={() => signOut({ callbackUrl: "/signin" })} className="text-sm px-3 py-1.5 rounded-xl border bg-white hover:bg-zinc-50">
            Sign out
          </button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <aside className="w-72 border-r border-zinc-200 bg-white overflow-y-auto">
          <div className="px-3 py-2 text-xs uppercase text-zinc-500 tracking-wide border-b">Databases</div>
          {loading && databases.length === 0 && <div className="p-3 text-sm text-zinc-500">Loading…</div>}
          {error && databases.length === 0 && <div className="p-3 text-sm text-red-600">{error}</div>}
          <ul className="text-sm">
            {databases.map((db) => (
              <li key={db}>
                <button
                  onClick={() => toggleDb(db)}
                  className="w-full text-left px-3 py-1.5 hover:bg-zinc-50 flex items-center gap-2"
                >
                  <span className="text-xs text-zinc-400">{expandedDb === db ? "▾" : "▸"}</span>
                  <span className="font-medium">{db}</span>
                </button>
                {expandedDb === db && (
                  <ul className="ml-5 border-l border-zinc-100">
                    {(tablesByDb[db] ?? []).length === 0 && (
                      <li className="px-3 py-1 text-xs text-zinc-400">{tablesByDb[db] ? "(empty)" : "Loading…"}</li>
                    )}
                    {(tablesByDb[db] ?? []).map((t) => (
                      <li key={t}>
                        <button
                          onClick={() => selectTable(db, t)}
                          className={
                            "w-full text-left px-3 py-1 hover:bg-zinc-50 " +
                            (selectedDb === db && selectedTable === t ? "bg-zinc-100 font-medium" : "")
                          }
                        >
                          {t}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </aside>

        {/* Main */}
        <section className="flex-1 min-h-0 flex flex-col">
          {!selectedTable && (
            <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
              Chọn một bảng ở sidebar để xem cấu trúc và dữ liệu.
            </div>
          )}

          {selectedTable && (
            <>
              <div className="border-b bg-white px-5 py-3 flex items-center justify-between">
                <div>
                  <div className="text-xs text-zinc-500">{selectedDb}</div>
                  <div className="text-base font-semibold">{selectedTable}</div>
                </div>
                <div className="flex items-center gap-2">
                  {view === "data" && columns.length > 0 && (
                    <button
                      onClick={openInsertModal}
                      className="px-3 py-1.5 rounded-xl text-sm border bg-emerald-600 text-white hover:bg-emerald-700"
                    >
                      + Insert row
                    </button>
                  )}
                  <div className="flex gap-1">
                    <button
                      onClick={() => setView("data")}
                      className={"px-3 py-1.5 rounded-xl text-sm border " + (view === "data" ? "bg-zinc-900 text-white" : "bg-white hover:bg-zinc-50")}
                    >
                      Data
                    </button>
                    <button
                      onClick={() => setView("columns")}
                      className={"px-3 py-1.5 rounded-xl text-sm border " + (view === "columns" ? "bg-zinc-900 text-white" : "bg-white hover:bg-zinc-50")}
                    >
                      Columns
                    </button>
                  </div>
                </div>
              </div>

              {error && <div className="m-4 text-sm text-red-600 border border-red-200 bg-red-50 rounded-xl p-3">{error}</div>}

              <div className="flex-1 overflow-auto">
                {view === "columns" && (
                  <table className="w-full text-sm border-separate border-spacing-0">
                    <thead className="sticky top-0 bg-zinc-100 text-left">
                      <tr>
                        <th className="px-3 py-2 border-b">Column</th>
                        <th className="px-3 py-2 border-b">Type</th>
                        <th className="px-3 py-2 border-b">Nullable</th>
                        <th className="px-3 py-2 border-b">PK</th>
                        <th className="px-3 py-2 border-b">Default</th>
                      </tr>
                    </thead>
                    <tbody>
                      {columns.map((c) => (
                        <tr key={c.name} className="hover:bg-zinc-50">
                          <td className="px-3 py-1.5 border-b font-medium">{c.name}</td>
                          <td className="px-3 py-1.5 border-b text-zinc-600">{c.dataType}</td>
                          <td className="px-3 py-1.5 border-b">{c.nullable ? "YES" : "NO"}</td>
                          <td className="px-3 py-1.5 border-b">{c.isPrimaryKey ? "🔑" : ""}</td>
                          <td className="px-3 py-1.5 border-b text-zinc-500">{c.default ?? ""}</td>
                        </tr>
                      ))}
                      {columns.length === 0 && !loading && (
                        <tr><td colSpan={5} className="px-3 py-4 text-center text-zinc-400">No columns</td></tr>
                      )}
                    </tbody>
                  </table>
                )}

                {view === "data" && rowsData && (
                  <table className="w-full text-sm border-separate border-spacing-0">
                    <thead className="sticky top-0 bg-zinc-100 text-left">
                      <tr>
                        {rowsData.columns.map((c) => (
                          <th key={c} className="px-3 py-2 border-b whitespace-nowrap">{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rowsData.rows.map((r, i) => (
                        <tr key={i} className="hover:bg-zinc-50">
                          {rowsData.columns.map((c) => (
                            <td key={c} className="px-3 py-1 border-b align-top max-w-[420px] overflow-hidden text-ellipsis whitespace-nowrap" title={formatCell(r[c])}>
                              {formatCell(r[c])}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {rowsData.rows.length === 0 && (
                        <tr><td colSpan={Math.max(1, rowsData.columns.length)} className="px-3 py-4 text-center text-zinc-400">No rows</td></tr>
                      )}
                    </tbody>
                  </table>
                )}
                {view === "data" && loading && !rowsData && <div className="p-4 text-sm text-zinc-500">Loading…</div>}
              </div>

              {view === "data" && rowsData && (
                <div className="border-t bg-white px-4 py-2 flex items-center justify-between text-sm">
                  <div className="text-zinc-500">
                    Page <strong>{currentPage}</strong> / {totalPages} — {rowsData.total.toLocaleString()} rows
                  </div>
                  <div className="flex gap-2">
                    <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))} className="px-3 py-1 rounded-xl border disabled:opacity-40">
                      ← Prev
                    </button>
                    <button disabled={offset + limit >= rowsData.total} onClick={() => setOffset(offset + limit)} className="px-3 py-1 rounded-xl border disabled:opacity-40">
                      Next →
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {/* Insert modal */}
      {insertOpen && selectedTable && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => !inserting && setInsertOpen(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <header className="px-5 py-3 border-b">
              <div className="text-xs text-zinc-500">{selectedDb}</div>
              <h2 className="text-base font-semibold">Insert row into {selectedTable}</h2>
            </header>
            <div className="flex-1 overflow-auto px-5 py-3 space-y-2">
              {columns.map((c) => (
                <div key={c.name} className="grid grid-cols-12 gap-2 items-center">
                  <label className="col-span-4 text-sm">
                    <span className="font-medium">{c.name}</span>
                    {c.isPrimaryKey && <span className="ml-1 text-amber-600">🔑</span>}
                    <div className="text-xs text-zinc-500">{c.dataType}{c.nullable ? "" : " · NOT NULL"}</div>
                  </label>
                  <div className="col-span-7">
                    <input
                      type="text"
                      className="w-full rounded-xl border p-2 text-sm disabled:bg-zinc-100 disabled:text-zinc-400"
                      placeholder={c.default ?? ""}
                      value={insertValues[c.name] ?? ""}
                      disabled={!!insertNulls[c.name]}
                      onChange={(e) => setInsertValues((v) => ({ ...v, [c.name]: e.target.value }))}
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={4096}
                    />
                  </div>
                  <label className="col-span-1 text-xs flex items-center gap-1" title={c.nullable ? "Set NULL" : "Column is NOT NULL"}>
                    <input
                      type="checkbox"
                      checked={!!insertNulls[c.name]}
                      disabled={!c.nullable}
                      onChange={(e) => setInsertNulls((n) => ({ ...n, [c.name]: e.target.checked }))}
                    />
                    NULL
                  </label>
                </div>
              ))}
            </div>
            {insertError && (
              <div className="mx-5 mb-2 text-sm rounded-xl border border-red-200 bg-red-50 text-red-700 p-3">{insertError}</div>
            )}
            <footer className="px-5 py-3 border-t flex items-center justify-end gap-2">
              <button
                onClick={() => setInsertOpen(false)}
                disabled={inserting}
                className="px-4 py-2 rounded-xl border bg-white hover:bg-zinc-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={submitInsert}
                disabled={inserting}
                className="px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {inserting ? "Inserting…" : "Insert"}
              </button>
            </footer>
          </div>
        </div>
      )}
    </main>
  );
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export default function ExplorerPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-zinc-500">Loading…</div>}>
      <ExplorerInner />
    </Suspense>
  );
}
