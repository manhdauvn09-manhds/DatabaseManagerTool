export interface Relationship {
  fromTable: string;
  fromColumn: string;
  likelyToTable: string;
  likelyPrimaryKey: string;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export function inferRelationships(
  table: string,
  columns: Array<{ name: string; dataType: string; isPrimaryKey: boolean }>,
  allTables: string[]
): Relationship[] {
  const rels: Relationship[] = [];

  for (const col of columns) {
    if (col.isPrimaryKey) continue;

    // Check for ID-based FK (user_id → users.id)
    const idMatch = col.name.match(/^(.+?)_id$/i);
    if (idMatch) {
      const targetTable = idMatch[1].toLowerCase() + "s";
      if (allTables.some((t) => t.toLowerCase() === targetTable)) {
        rels.push({
          fromTable: table,
          fromColumn: col.name,
          likelyToTable: allTables.find((t) => t.toLowerCase() === targetTable) || targetTable,
          likelyPrimaryKey: "id",
          confidence: "high",
          reason: "Column name matches table naming convention"
        });
      }
    }

    // Check for singular table reference (user → users)
    const singular = col.name.replace(/s$/, "").toLowerCase();
    const plural = col.name.toLowerCase() + "s";
    const matchingTable = allTables.find(
      (t) =>
        t.toLowerCase() === singular ||
        t.toLowerCase() === plural ||
        t.toLowerCase() === col.name.toLowerCase()
    );
    if (matchingTable && !rels.some((r) => r.fromColumn === col.name)) {
      rels.push({
        fromTable: table,
        fromColumn: col.name,
        likelyToTable: matchingTable,
        likelyPrimaryKey: "id",
        confidence: "medium",
        reason: "Column name suggests reference to another table"
      });
    }
  }

  return rels.filter((r, i, arr) => arr.findIndex((x) => x.fromColumn === r.fromColumn) === i);
}
