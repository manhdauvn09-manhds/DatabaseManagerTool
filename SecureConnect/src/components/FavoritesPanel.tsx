"use client";

import { useEffect, useState } from "react";
import {
  getFavoriteQueries,
  deleteFavoriteQuery,
  type FavoriteQuery,
} from "@/lib/favoriteQueries";

interface FavoritesPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectQuery: (query: string) => void;
  database?: string;
  table?: string;
}

export function FavoritesPanel({
  isOpen,
  onClose,
  onSelectQuery,
  database,
  table,
}: FavoritesPanelProps) {
  const [favorites, setFavorites] = useState<FavoriteQuery[]>([]);

  useEffect(() => {
    if (isOpen) {
      const faves = getFavoriteQueries(database, table);
      setFavorites(faves);
    }
  }, [isOpen, database, table]);

  const handleDelete = (id: string) => {
    deleteFavoriteQuery(id);
    setFavorites(favorites.filter((f) => f.id !== id));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-[var(--bg-secondary)] rounded-lg shadow-xl w-full max-w-2xl max-h-96 flex flex-col">
        <div className="flex justify-between items-center p-4 border-b border-[var(--border-color)]">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Favorite Queries</h2>
          <button
            onClick={onClose}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {favorites.length === 0 ? (
            <div className="p-4 text-center text-[var(--text-tertiary)]">
              No saved favorites
            </div>
          ) : (
            <div className="divide-y divide-[var(--border-color)]">
              {favorites.map((fav) => (
                <div
                  key={fav.id}
                  className="p-3 hover:bg-[var(--bg-tertiary)] cursor-pointer transition"
                >
                  <div className="flex justify-between items-start gap-2">
                    <div
                      className="flex-1 min-w-0"
                      onClick={() => {
                        onSelectQuery(fav.query);
                        onClose();
                      }}
                    >
                      <div className="font-medium text-[var(--text-primary)] text-sm">
                        {fav.name}
                      </div>
                      {fav.description && (
                        <div className="text-xs text-[var(--text-tertiary)] mt-1">
                          {fav.description}
                        </div>
                      )}
                      <code className="text-xs text-[var(--text-secondary)] block truncate mt-1">
                        {fav.query}
                      </code>
                    </div>
                    <button
                      onClick={() => handleDelete(fav.id)}
                      className="text-[var(--text-tertiary)] hover:text-red-500 text-xs px-2"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="p-3 border-t border-[var(--border-color)] text-right">
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
