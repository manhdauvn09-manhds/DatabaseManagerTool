"use client";

import { useState } from "react";

export interface ImportWizardProps {
  columns: string[];
  onImport: (rows: Record<string, string>[]) => Promise<void>;
  onClose: () => void;
}

export function ImportWizard({ columns, onImport, onClose }: ImportWizardProps) {
  const [csvText, setCsvText] = useState("");
  const [stage, setStage] = useState<"input" | "preview" | "confirm">("input");
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  function parseCSV() {
    try {
      const lines = csvText.trim().split("\n");
      if (lines.length < 2) throw new Error("CSV must have header + at least 1 data row");

      const headers = lines[0].split(",").map((h) => h.trim());
      const parsed: Record<string, string>[] = [];
      const errs: string[] = [];

      // Map CSV headers to table columns
      const headerMap = new Map<number, string>();
      headers.forEach((h, i) => {
        const col = columns.find((c) => c.toLowerCase() === h.toLowerCase());
        if (col) headerMap.set(i, col);
      });

      // Parse data rows
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const values = line.split(",").map((v) => v.trim());
        const row: Record<string, string> = {};

        values.forEach((v, j) => {
          const colName = headerMap.get(j);
          if (colName) row[colName] = v;
        });

        if (Object.keys(row).length > 0) {
          parsed.push(row);
        } else {
          errs.push(`Row ${i + 1}: No valid columns matched`);
        }
      }

      if (parsed.length === 0) throw new Error("No valid data rows found");
      if (errs.length > 0) setErrors(errs);

      setRows(parsed);
      setStage("preview");
    } catch (e) {
      setErrors([e instanceof Error ? e.message : String(e)]);
    }
  }

  async function executeImport() {
    setImporting(true);
    setImportError(null);
    try {
      await onImport(rows);
      onClose();
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-zinc-800 rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b dark:border-zinc-700 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Import Data</h2>
          <button
            onClick={onClose}
            className="text-sm px-3 py-1 rounded-xl border bg-white dark:bg-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-600"
          >
            Close
          </button>
        </header>

        <div className="flex-1 overflow-auto px-5 py-3">
          {stage === "input" && (
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-2">Paste CSV data</label>
                <textarea
                  value={csvText}
                  onChange={(e) => setCsvText(e.target.value)}
                  placeholder="Column1, Column2, Column3&#10;Value1, Value2, Value3&#10;Value4, Value5, Value6"
                  className="w-full h-48 rounded-lg border p-3 font-mono text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                />
              </div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                Expected columns: {columns.join(", ")}
              </div>
            </div>
          )}

          {stage === "preview" && rows.length > 0 && (
            <div className="space-y-3">
              <div className="text-sm">
                <strong>{rows.length} rows</strong> ready to import
              </div>
              <div className="overflow-x-auto border rounded-lg dark:border-zinc-600">
                <table className="w-full text-sm border-collapse">
                  <thead className="bg-zinc-100 dark:bg-zinc-700">
                    <tr>
                      {columns.map((c) => (
                        <th key={c} className="px-3 py-2 text-left font-medium border-r dark:border-zinc-600">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 10).map((r, i) => (
                      <tr key={i} className="border-t dark:border-zinc-600">
                        {columns.map((c) => (
                          <td key={c} className="px-3 py-2 border-r dark:border-zinc-600 max-w-[200px] truncate">
                            {r[c] ?? "—"}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > 10 && <div className="text-xs text-zinc-500">... and {rows.length - 10} more rows</div>}
              {errors.length > 0 && (
                <div className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 p-3 rounded-lg">
                  ⚠️ {errors.length} warnings: {errors.slice(0, 3).join("; ")}
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="px-5 py-3 border-t dark:border-zinc-700 flex items-center justify-between gap-2">
          <button
            onClick={() => setStage("input")}
            disabled={stage === "input" || importing}
            className="px-4 py-2 rounded-xl border bg-white dark:bg-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-600 disabled:opacity-50"
          >
            ← Back
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={importing}
              className="px-4 py-2 rounded-xl border bg-white dark:bg-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-600 disabled:opacity-50"
            >
              Cancel
            </button>
            {stage === "input" && (
              <button
                onClick={parseCSV}
                disabled={!csvText.trim()}
                className="px-4 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Parse CSV →
              </button>
            )}
            {stage === "preview" && (
              <button
                onClick={() => setStage("confirm")}
                className="px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700"
              >
                Import data →
              </button>
            )}
          </div>
        </footer>

        {stage === "confirm" && (
          <div className="border-t dark:border-zinc-700 px-5 py-3 bg-emerald-50 dark:bg-emerald-900/20">
            {importError && (
              <div className="mb-3 text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/20 p-3 rounded-lg">
                {importError}
              </div>
            )}
            <button
              onClick={executeImport}
              disabled={importing}
              className="w-full px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {importing ? "Importing..." : `Confirm: Import ${rows.length} rows`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
