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

  // Edit row modal state (2-stage: form → confirm)
  type PreviewState = { token: string; total: number; sample: Record<string, unknown>[]; columns: string[]; hasPrimaryKey: boolean };
  const [editOpen, setEditOpen] = useState(false);
  const [editOrig, setEditOrig] = useState<Record<string, unknown> | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [editNulls, setEditNulls] = useState<Record<string, boolean>>({});
  const [editStage, setEditStage] = useState<"form" | "confirm">("form");
  const [editPreview, setEditPreview] = useState<PreviewState | null>(null);
  const [editTokenInput, setEditTokenInput] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Delete row modal state
  const [delOpen, setDelOpen] = useState(false);
  const [delOrig, setDelOrig] = useState<Record<string, unknown> | null>(null);
  const [delPreview, setDelPreview] = useState<PreviewState | null>(null);
  const [delTokenInput, setDelTokenInput] = useState("");
  const [delBusy, setDelBusy] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);

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

  const apiSend = useCallback(async <T,>(path: string, method: "PUT" | "DELETE" | "POST", body: unknown): Promise<T> => {
    const res = await fetch(path, {
      method,
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

  // Build a safe WHERE clause from an original row — primitives + short strings only.
  function buildWhereFromRow(row: Record<string, unknown>): Record<string, string | number | boolean | null> {
    const w: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(row)) {
      if (v === null || v === undefined) w[k] = null;
      else if (typeof v === "number" || typeof v === "boolean") w[k] = v;
      else if (typeof v === "string" && v.length <= 256) w[k] = v;
      // Skip large strings / objects / buffers — server will rely on remaining cols.
    }
    return w;
  }

  function openEditModal(row: Record<string, unknown>) {
    const vals: Record<string, string> = {};
    const nulls: Record<string, boolean> = {};
    for (const c of columns) {
      const v = row[c.name];
      if (v === null || v === undefined) { vals[c.name] = ""; nulls[c.name] = true; }
      else { vals[c.name] = String(v); nulls[c.name] = false; }
    }
    setEditOrig(row);
    setEditValues(vals);
    setEditNulls(nulls);
    setEditStage("form");
    setEditPreview(null);
    setEditTokenInput("");
    setEditError(null);
    setEditOpen(true);
  }

  function diffEditSet(): Record<string, string | number | boolean | null> {
    if (!editOrig) return {};
    const set: Record<string, string | number | boolean | null> = {};
    for (const c of columns) {
      const wantNull = !!editNulls[c.name];
      const newStr = editValues[c.name] ?? "";
      const orig = editOrig[c.name];
      const origStr = orig === null || orig === undefined ? null : String(orig);
      const newVal = wantNull ? null : newStr;
      if (wantNull && origStr === null) continue;
      if (!wantNull && newStr === origStr) continue;
      set[c.name] = newVal;
    }
    return set;
  }

  async function editPreviewSubmit() {
    if (!selectedDb || !selectedTable || !editOrig) return;
    const set = diffEditSet();
    if (Object.keys(set).length === 0) {
      setEditError("No changes detected.");
      return;
    }
    const where = buildWhereFromRow(editOrig);
    setEditBusy(true);
    setEditError(null);
    try {
      const preview = await apiSend<PreviewState>(`/api/db/${cid}/rows/preview`, "POST", {
        database: selectedDb,
        table: selectedTable,
        action: "update",
        where,
        set
      });
      setEditPreview(preview);
      setEditStage("confirm");
    } catch (e) {
      setEditError(String(e instanceof Error ? e.message : e));
    } finally {
      setEditBusy(false);
    }
  }

  async function editExecute() {
    if (!selectedDb || !selectedTable || !editOrig || !editPreview) return;
    if (editTokenInput.trim().toUpperCase() !== editPreview.token) {
      setEditError("Token không khớp.");
      return;
    }
    const set = diffEditSet();
    const where = buildWhereFromRow(editOrig);
    setEditBusy(true);
    setEditError(null);
    try {
      const r = await apiSend<{ affected: number }>(`/api/db/${cid}/rows`, "PUT", {
        database: selectedDb,
        table: selectedTable,
        where,
        set,
        token: editPreview.token
      });
      setEditOpen(false);
      setRefreshSeq((n) => n + 1);
      setError(`Updated ${r.affected} row(s).`);
      setTimeout(() => setError(null), 3500);
    } catch (e) {
      setEditError(String(e instanceof Error ? e.message : e));
    } finally {
      setEditBusy(false);
    }
  }

  async function openDeleteModal(row: Record<string, unknown>) {
    if (!selectedDb || !selectedTable) return;
    setDelOrig(row);
    setDelTokenInput("");
    setDelError(null);
    setDelPreview(null);
    setDelOpen(true);
    setDelBusy(true);
    try {
      const where = buildWhereFromRow(row);
      const preview = await apiSend<PreviewState>(`/api/db/${cid}/rows/preview`, "POST", {
        database: selectedDb,
        table: selectedTable,
        action: "delete",
        where
      });
      setDelPreview(preview);
    } catch (e) {
      setDelError(String(e instanceof Error ? e.message : e));
    } finally {
      setDelBusy(false);
    }
  }

  async function deleteExecute() {
    if (!selectedDb || !selectedTable || !delOrig || !delPreview) return;
    if (delTokenInput.trim().toUpperCase() !== delPreview.token) {
      setDelError("Token không khớp.");
      return;
    }
    const where = buildWhereFromRow(delOrig);
    setDelBusy(true);
    setDelError(null);
    try {
      const r = await apiSend<{ affected: number; backupPath: string | null }>(`/api/db/${cid}/rows`, "DELETE", {
        database: selectedDb,
        table: selectedTable,
        where,
        token: delPreview.token
      });
      setDelOpen(false);
      setRefreshSeq((n) => n + 1);
      const bk = r.backupPath ? ` Backup: ${r.backupPath}` : "";
      setError(`Deleted ${r.affected} row(s).${bk}`);
      setTimeout(() => setError(null), 5000);
    } catch (e) {
      setDelError(String(e instanceof Error ? e.message : e));
    } finally {
      setDelBusy(false);
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
                        <th className="px-2 py-2 border-b w-20">Actions</th>
                        {rowsData.columns.map((c) => (
                          <th key={c} className="px-3 py-2 border-b whitespace-nowrap">{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rowsData.rows.map((r, i) => (
                        <tr key={i} className="hover:bg-zinc-50">
                          <td className="px-2 py-1 border-b whitespace-nowrap">
                            <button
                              onClick={() => openEditModal(r)}
                              className="text-xs px-2 py-0.5 rounded border border-zinc-300 bg-white hover:bg-amber-50 hover:border-amber-400 mr-1"
                              title="Edit row"
                            >
                              ✏️
                            </button>
                            <button
                              onClick={() => openDeleteModal(r)}
                              className="text-xs px-2 py-0.5 rounded border border-zinc-300 bg-white hover:bg-red-50 hover:border-red-400"
                              title="Delete row"
                            >
                              🗑️
                            </button>
                          </td>
                          {rowsData.columns.map((c) => (
                            <td key={c} className="px-3 py-1 border-b align-top max-w-[420px] overflow-hidden text-ellipsis whitespace-nowrap" title={formatCell(r[c])}>
                              {formatCell(r[c])}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {rowsData.rows.length === 0 && (
                        <tr><td colSpan={Math.max(1, rowsData.columns.length) + 1} className="px-3 py-4 text-center text-zinc-400">No rows</td></tr>
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

      {/* Edit modal — 2 stages: form → confirm */}
      {editOpen && selectedTable && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => !editBusy && setEditOpen(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <header className="px-5 py-3 border-b">
              <div className="text-xs text-zinc-500">{selectedDb} · {editStage === "form" ? "Edit" : "Confirm update"}</div>
              <h2 className="text-base font-semibold">{selectedTable}</h2>
            </header>

            {editStage === "form" && (
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
                        value={editValues[c.name] ?? ""}
                        disabled={!!editNulls[c.name]}
                        onChange={(e) => setEditValues((v) => ({ ...v, [c.name]: e.target.value }))}
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={4096}
                      />
                    </div>
                    <label className="col-span-1 text-xs flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={!!editNulls[c.name]}
                        disabled={!c.nullable}
                        onChange={(e) => setEditNulls((n) => ({ ...n, [c.name]: e.target.checked }))}
                      />
                      NULL
                    </label>
                  </div>
                ))}
              </div>
            )}

            {editStage === "confirm" && editPreview && (
              <div className="flex-1 overflow-auto px-5 py-3 space-y-3 text-sm">
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                  <div><strong>Will update {editPreview.total} row(s).</strong></div>
                  {editPreview.total > 1 && (
                    <div className="text-amber-900 text-xs mt-1">⚠️ Match nhiều dòng — WHERE có thể không đủ chặt.</div>
                  )}
                  {!editPreview.hasPrimaryKey && (
                    <div className="text-amber-900 text-xs mt-1">⚠️ WHERE không có PRIMARY KEY — match có thể không deterministic.</div>
                  )}
                </div>
                <div>
                  <div className="text-xs uppercase text-zinc-500 mb-1">Changes</div>
                  <table className="w-full text-xs border-separate border-spacing-0">
                    <thead className="bg-zinc-100"><tr><th className="px-2 py-1 border-b text-left">Column</th><th className="px-2 py-1 border-b text-left">Old</th><th className="px-2 py-1 border-b text-left">New</th></tr></thead>
                    <tbody>
                      {Object.entries(diffEditSet()).map(([k, v]) => (
                        <tr key={k}>
                          <td className="px-2 py-1 border-b font-medium">{k}</td>
                          <td className="px-2 py-1 border-b text-zinc-600">{formatCell(editOrig?.[k])}</td>
                          <td className="px-2 py-1 border-b text-emerald-700">{v === null ? "NULL" : String(v)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div>
                  <div className="text-xs uppercase text-zinc-500 mb-1">Sample matched rows</div>
                  <div className="rounded-xl border bg-zinc-50 p-2 max-h-48 overflow-auto text-xs">
                    <pre>{JSON.stringify(editPreview.sample, null, 2)}</pre>
                  </div>
                </div>
                <div>
                  <label className="text-sm">
                    Gõ token để xác nhận: <code className="bg-zinc-900 text-white px-2 py-0.5 rounded font-mono">{editPreview.token}</code>
                  </label>
                  <input
                    type="text"
                    className="mt-1 w-full rounded-xl border p-2 font-mono text-sm uppercase tracking-widest"
                    value={editTokenInput}
                    onChange={(e) => setEditTokenInput(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={8}
                  />
                </div>
              </div>
            )}

            {editError && (
              <div className="mx-5 mb-2 text-sm rounded-xl border border-red-200 bg-red-50 text-red-700 p-3">{editError}</div>
            )}

            <footer className="px-5 py-3 border-t flex items-center justify-between gap-2">
              <button onClick={() => setEditOpen(false)} disabled={editBusy} className="px-4 py-2 rounded-xl border bg-white hover:bg-zinc-50 disabled:opacity-50">
                Cancel
              </button>
              {editStage === "form" && (
                <button onClick={editPreviewSubmit} disabled={editBusy} className="px-4 py-2 rounded-xl bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50">
                  {editBusy ? "Preview…" : "Preview update →"}
                </button>
              )}
              {editStage === "confirm" && (
                <div className="flex gap-2">
                  <button onClick={() => setEditStage("form")} disabled={editBusy} className="px-4 py-2 rounded-xl border bg-white hover:bg-zinc-50 disabled:opacity-50">
                    ← Back
                  </button>
                  <button onClick={editExecute} disabled={editBusy || editTokenInput.length < 8} className="px-4 py-2 rounded-xl bg-amber-700 text-white hover:bg-amber-800 disabled:opacity-50">
                    {editBusy ? "Updating…" : "Confirm update"}
                  </button>
                </div>
              )}
            </footer>
          </div>
        </div>
      )}

      {/* Delete modal */}
      {delOpen && selectedTable && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => !delBusy && setDelOpen(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <header className="px-5 py-3 border-b">
              <div className="text-xs text-zinc-500">{selectedDb} · Confirm DELETE</div>
              <h2 className="text-base font-semibold text-red-700">Delete row from {selectedTable}</h2>
            </header>
            <div className="flex-1 overflow-auto px-5 py-3 space-y-3 text-sm">
              {!delPreview && !delError && <div className="text-zinc-500">Loading preview…</div>}
              {delPreview && (
                <>
                  <div className="rounded-xl border border-red-200 bg-red-50 p-3">
                    <div><strong>Will DELETE {delPreview.total} row(s) permanently.</strong></div>
                    {delPreview.total > 1 && <div className="text-red-900 text-xs mt-1">⚠️ Match nhiều dòng — WHERE có thể không đủ chặt.</div>}
                    {!delPreview.hasPrimaryKey && <div className="text-red-900 text-xs mt-1">⚠️ WHERE không có PRIMARY KEY — match có thể không deterministic.</div>}
                  </div>
                  <div>
                    <div className="text-xs uppercase text-zinc-500 mb-1">Sample matched rows</div>
                    <div className="rounded-xl border bg-zinc-50 p-2 max-h-64 overflow-auto text-xs">
                      <pre>{JSON.stringify(delPreview.sample, null, 2)}</pre>
                    </div>
                  </div>
                  <div>
                    <label className="text-sm">
                      Gõ token để xác nhận xoá: <code className="bg-red-700 text-white px-2 py-0.5 rounded font-mono">{delPreview.token}</code>
                    </label>
                    <input
                      type="text"
                      className="mt-1 w-full rounded-xl border p-2 font-mono text-sm uppercase tracking-widest"
                      value={delTokenInput}
                      onChange={(e) => setDelTokenInput(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={8}
                    />
                  </div>
                </>
              )}
            </div>
            {delError && (
              <div className="mx-5 mb-2 text-sm rounded-xl border border-red-200 bg-red-50 text-red-700 p-3">{delError}</div>
            )}
            <footer className="px-5 py-3 border-t flex items-center justify-between gap-2">
              <button onClick={() => setDelOpen(false)} disabled={delBusy} className="px-4 py-2 rounded-xl border bg-white hover:bg-zinc-50 disabled:opacity-50">
                Cancel
              </button>
              <button onClick={deleteExecute} disabled={delBusy || !delPreview || delTokenInput.length < 8} className="px-4 py-2 rounded-xl bg-red-700 text-white hover:bg-red-800 disabled:opacity-50">
                {delBusy ? "Deleting…" : "Confirm DELETE"}
              </button>
            </footer>
          </div>
        </div>
      )}

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
