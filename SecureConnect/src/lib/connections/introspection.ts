/**
 * Driver-specific introspection helpers. All return a uniform shape so the FE can
 * render generically.
 */
import { quoteIdent, validateIdent, type DriverType, type QueryFn } from "./dbConnector";

export type ColumnInfo = {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  default: string | null;
};

// ---------- databases ----------

export async function listDatabases(q: QueryFn, driver: DriverType): Promise<string[]> {
  if (driver === "mysql") {
    const { rows } = await q(
      "SELECT schema_name AS name FROM information_schema.schemata " +
      "WHERE schema_name NOT IN ('information_schema','mysql','performance_schema','sys') ORDER BY 1"
    );
    return rows.map((r) => String(r.name));
  }
  if (driver === "postgresql") {
    const { rows } = await q(
      "SELECT datname AS name FROM pg_database WHERE datistemplate = false AND datname NOT IN ('postgres') ORDER BY 1"
    );
    return rows.map((r) => String(r.name));
  }
  // mssql
  const { rows } = await q(
    "SELECT name FROM sys.databases WHERE database_id > 4 AND state = 0 ORDER BY name"
  );
  return rows.map((r) => String(r.name));
}

// ---------- tables ----------

export async function listTables(q: QueryFn, driver: DriverType, database: string): Promise<string[]> {
  validateIdent(database, "database");
  if (driver === "mysql") {
    const { rows } = await q(
      "SELECT table_name AS name FROM information_schema.tables " +
      "WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY 1",
      [database]
    );
    return rows.map((r) => String(r.name));
  }
  if (driver === "postgresql") {
    const { rows } = await q(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname = $1 ORDER BY 1",
      [database]
    );
    return rows.map((r) => String(r.name));
  }
  // mssql — `database` is the schema name (we treat schema = "database" for UI purposes)
  const { rows } = await q(
    "SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY 1",
    [database]
  );
  return rows.map((r) => String(r.name));
}

// ---------- columns ----------

export async function listColumns(
  q: QueryFn,
  driver: DriverType,
  database: string,
  table: string
): Promise<ColumnInfo[]> {
  validateIdent(database, "database");
  validateIdent(table, "table");
  if (driver === "mysql") {
    const { rows } = await q(
      "SELECT column_name AS name, column_type AS dataType, is_nullable AS nullable, " +
      "column_default AS `default`, column_key AS keyType " +
      "FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
      [database, table]
    );
    return rows.map((r) => ({
      name: String(r.name),
      dataType: String(r.dataType),
      nullable: String(r.nullable).toUpperCase() === "YES",
      isPrimaryKey: String(r.keyType ?? "").toUpperCase() === "PRI",
      default: r.default === null || r.default === undefined ? null : String(r.default)
    }));
  }
  if (driver === "postgresql") {
    const { rows } = await q(
      `SELECT c.column_name AS name,
              c.data_type AS "dataType",
              c.is_nullable AS nullable,
              c.column_default AS "default",
              CASE WHEN kcu.column_name IS NOT NULL THEN 'YES' ELSE 'NO' END AS "isPk"
       FROM information_schema.columns c
       LEFT JOIN information_schema.key_column_usage kcu
         ON kcu.table_schema = c.table_schema AND kcu.table_name = c.table_name
        AND kcu.column_name = c.column_name
        AND kcu.constraint_name IN (
          SELECT constraint_name FROM information_schema.table_constraints
          WHERE constraint_type = 'PRIMARY KEY' AND table_schema = c.table_schema AND table_name = c.table_name
        )
       WHERE c.table_schema = $1 AND c.table_name = $2
       ORDER BY c.ordinal_position`,
      [database, table]
    );
    return rows.map((r) => ({
      name: String(r.name),
      dataType: String(r.dataType),
      nullable: String(r.nullable).toUpperCase() === "YES",
      isPrimaryKey: String(r.isPk).toUpperCase() === "YES",
      default: r.default === null || r.default === undefined ? null : String(r.default)
    }));
  }
  // mssql
  const { rows } = await q(
    "SELECT c.COLUMN_NAME AS name, c.DATA_TYPE AS dataType, c.IS_NULLABLE AS nullable, " +
    "c.COLUMN_DEFAULT AS [default], " +
    "CASE WHEN kcu.COLUMN_NAME IS NOT NULL THEN 'YES' ELSE 'NO' END AS isPk " +
    "FROM INFORMATION_SCHEMA.COLUMNS c " +
    "LEFT JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu " +
    "  ON kcu.TABLE_SCHEMA = c.TABLE_SCHEMA AND kcu.TABLE_NAME = c.TABLE_NAME " +
    "  AND kcu.COLUMN_NAME = c.COLUMN_NAME " +
    "  AND kcu.CONSTRAINT_NAME IN (" +
    "    SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS " +
    "    WHERE CONSTRAINT_TYPE = 'PRIMARY KEY' AND TABLE_SCHEMA = c.TABLE_SCHEMA AND TABLE_NAME = c.TABLE_NAME" +
    "  ) " +
    "WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ? ORDER BY c.ORDINAL_POSITION",
    [database, table]
  );
  return rows.map((r) => ({
    name: String(r.name),
    dataType: String(r.dataType),
    nullable: String(r.nullable).toUpperCase() === "YES",
    isPrimaryKey: String(r.isPk).toUpperCase() === "YES",
    default: r.default === null || r.default === undefined ? null : String(r.default)
  }));
}

// ---------- rows (paginated) ----------

export async function listRows(
  q: QueryFn,
  driver: DriverType,
  database: string,
  table: string,
  limit: number,
  offset: number
): Promise<{ columns: string[]; rows: Record<string, unknown>[]; total: number }> {
  validateIdent(database, "database");
  validateIdent(table, "table");

  const lim = Math.max(1, Math.min(1000, Math.floor(limit)));
  const off = Math.max(0, Math.floor(offset));

  if (driver === "mysql") {
    const fq = `${quoteIdent(database, "mysql")}.${quoteIdent(table, "mysql")}`;
    const totalRes = await q(`SELECT COUNT(*) AS total FROM ${fq}`);
    const total = Number((totalRes.rows[0] as { total: number | string }).total ?? 0);
    const data = await q(`SELECT * FROM ${fq} LIMIT ? OFFSET ?`, [lim, off]);
    return { columns: data.columns, rows: data.rows, total };
  }
  if (driver === "postgresql") {
    const fq = `${quoteIdent(database, "postgresql")}.${quoteIdent(table, "postgresql")}`;
    const totalRes = await q(`SELECT COUNT(*) AS total FROM ${fq}`);
    const total = Number((totalRes.rows[0] as { total: number | string }).total ?? 0);
    const data = await q(`SELECT * FROM ${fq} LIMIT $1 OFFSET $2`, [lim, off]);
    return { columns: data.columns, rows: data.rows, total };
  }
  // mssql: schema.table; pagination via OFFSET/FETCH (requires ORDER BY)
  const fq = `${quoteIdent(database, "mssql")}.${quoteIdent(table, "mssql")}`;
  const totalRes = await q(`SELECT COUNT(*) AS total FROM ${fq}`);
  const total = Number((totalRes.rows[0] as { total: number | string }).total ?? 0);
  const data = await q(
    `SELECT * FROM ${fq} ORDER BY (SELECT NULL) OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`,
    [off, lim]
  );
  return { columns: data.columns, rows: data.rows, total };
}
