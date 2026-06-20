const STORAGE_KEY = "dbm_favorite_queries";

export interface FavoriteQuery {
  id: string;
  name: string;
  query: string;
  database: string;
  table: string;
  createdAt: number;
  description?: string;
}

function getFavorites(): FavoriteQuery[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export function saveFavoriteQuery(
  name: string,
  query: string,
  database: string,
  table: string,
  description?: string
): FavoriteQuery {
  const favorites = getFavorites();
  const newFavorite: FavoriteQuery = {
    id: `fav_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    name,
    query: query.trim(),
    database,
    table,
    createdAt: Date.now(),
    description,
  };

  favorites.push(newFavorite);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
  return newFavorite;
}

export function getFavoriteQueries(database?: string, table?: string): FavoriteQuery[] {
  const favorites = getFavorites();
  return favorites.filter((f) => {
    if (database && f.database !== database) return false;
    if (table && f.table !== table) return false;
    return true;
  });
}

export function deleteFavoriteQuery(id: string): void {
  const favorites = getFavorites();
  const filtered = favorites.filter((f) => f.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
}

export function updateFavoriteQuery(
  id: string,
  updates: Partial<Omit<FavoriteQuery, "id" | "createdAt">>
): void {
  const favorites = getFavorites();
  const index = favorites.findIndex((f) => f.id === id);
  if (index !== -1) {
    favorites[index] = { ...favorites[index], ...updates };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
  }
}

export function isFavorited(query: string, database: string, table: string): boolean {
  const favorites = getFavorites();
  return favorites.some(
    (f) =>
      f.query === query.trim() && f.database === database && f.table === table
  );
}
