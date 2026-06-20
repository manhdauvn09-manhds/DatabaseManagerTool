"use client";

import { useEffect, useState } from "react";
import {
  getQueryHistory,
  deleteQueryFromHistory,
  clearQueryHistory,
  type QueryHistoryEntry,
} from "@/lib/queryHistory";

interface QueryHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectQuery: (query: string) => void;
  connectionId?: string;
  database?: string;
  table?: string;
}

export function QueryHistoryModal({
  isOpen,
  onClose,
  onSelectQuery,
  connectionId,
  database,
  table,
}: QueryHistoryModalProps) {
  const [history, setHistory] = useState<QueryHistoryEntry[]>([]);

  useEffect(() => {
    if (isOpen) {
      const entries = getQueryHistory(connectionId, database, table);
      setHistory(entries);
    }
  }, [isOpen, connectionId, database, table]);

  const handleDelete = (id: string) => {
    deleteQueryFromHistory(id);
    setHistory(history.filter((e) => e.id !== id));
  };

  const handleClear = () => {
    if (confirm("Clear all query history?")) {
      clearQueryHistory();
      setHistory([]);
    }
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - timestamp;

    if (diff < 60000) return "just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return date.toLocaleDateString();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-[var(--bg-secondary)] rounded-lg shadow-xl w-full max-w-2xl max-h-96 flex flex-col">
        <div className="flex justify-between items-center p-4 border-b border-[var(--border-color)]">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Query History</h2>
          <button
            onClick={onClose}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {history.length === 0 ? (
            <div className="p-4 text-center text-[var(--text-tertiary)]">
              No query history
            </div>
          ) : (
            <div className="divide-y divide-[var(--border-color)]">
              {history.map((entry) => (
                <div
                  key={entry.id}
                  className="p-3 hover:bg-[var(--bg-tertiary)] cursor-pointer transition"
                >
                  <div className="flex justify-between items-start gap-2">
                    <div
                      className="flex-1 min-w-0"
                      onClick={() => {
                        onSelectQuery(entry.query);
                        onClose();
                      }}
                    >
                      <code className="text-xs text-[var(--text-secondary)] block truncate">
                        {entry.query}
                      </code>
                      <div className="text-xs text-[var(--text-tertiary)] mt-1 space-x-2">
                        <span>{formatTime(entry.timestamp)}</span>
                        <span>•</span>
                        <span>{entry.duration}ms</span>
                        <span>•</span>
                        <span>{entry.rowCount} rows</span>
                      </div>
                    </div>
                    <button
                      onClick={() => handleDelete(entry.id)}
                      className="text-[var(--text-tertiary)] hover:text-red-500 text-xs px-2"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-between gap-2 p-3 border-t border-[var(--border-color)] bg-[var(--bg-tertiary)]">
          <button
            onClick={handleClear}
            className="px-3 py-1 text-sm text-red-600 hover:bg-red-100 rounded"
          >
            Clear All
          </button>
          <button
            onClick={onClose}
            className="px-3 py-1 text-sm bg-[var(--focus-ring)] text-white rounded hover:opacity-90"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
