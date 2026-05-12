// Minimal shim for mssql v10. The npm package ships types under tedious/built-in
// paths that aren't auto-discovered with moduleResolution: "bundler". We only use
// a tiny subset (ConnectionPool, request.query, close).

declare module "mssql" {
  export interface ConnectionPoolConfig {
    server: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    connectionTimeout?: number;
    requestTimeout?: number;
    options?: {
      encrypt?: boolean;
      trustServerCertificate?: boolean;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }

  export class Request {
    query(sql: string): Promise<{ recordset: unknown[]; recordsets: unknown[][]; output: Record<string, unknown>; rowsAffected: number[] }>;
  }

  export class ConnectionPool {
    constructor(config: ConnectionPoolConfig);
    connect(): Promise<ConnectionPool>;
    close(): Promise<void>;
    request(): Request;
  }

  export function connect(config: ConnectionPoolConfig): Promise<ConnectionPool>;

  const mssql: {
    ConnectionPool: typeof ConnectionPool;
    Request: typeof Request;
    connect: typeof connect;
  };
  export default mssql;
}
