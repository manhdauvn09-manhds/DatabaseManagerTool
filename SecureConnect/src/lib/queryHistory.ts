const STORAGE_KEY = "dbm_query_history";
const MAX_HISTORY = 50;

export interface QueryHistoryEntry {
  id: string;
  query: string;
  database: string;
  table: string;
  timestamp: number;
  duration: number;
  rowCount: number;
  connectionId: string;
}

function getHistory(): QueryHistoryEntry[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export function addQueryToHistory(
  query: string,
  database: string,
  table: string,
  rowCount: number,
  duration: number,
  connectionId: string
): void {
  const history = getHistory();
  const entry: QueryHistoryEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    query: query.trim(),
    database,
    table,
    timestamp: Date.now(),
    duration,
    rowCount,
    connectionId,
  };

  history.unshift(entry);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
}

export function getQueryHistory(
  connectionId?: string,
  database?: string,
  table?: string
): QueryHistoryEntry[] {
  const history = getHistory();
  return history.filter((e) => {
    if (connectionId && e.connectionId !== connectionId) return false;
    if (database && e.database !== database) return false;
    if (table && e.table !== table) return false;
    return true;
  });
}

export function clearQueryHistory(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function deleteQueryFromHistory(id: string): void {
  const history = getHistory();
  const filtered = history.filter((e) => e.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
}
