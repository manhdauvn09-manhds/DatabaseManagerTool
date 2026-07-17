export type AuditEvent = {
  action: string;
  email?: string;
  ip?: string;
  host?: string;
  port?: number;
  dbType?: string;
  ok: boolean;
  errCode?: string;
  ms?: number;
};

// Whitelist of fields that may appear in an audit record. Any extra is dropped.
// Ensures secrets (password, passwordEncrypted, keyId) can never leak via audit().
const ALLOWED_FIELDS = new Set<keyof AuditEvent>([
  "action", "email", "ip", "host", "port", "dbType", "ok", "errCode", "ms"
]);

export function audit(event: AuditEvent): void {
  const record: Record<string, unknown> = { ts: new Date().toISOString() };
  for (const k of Object.keys(event) as Array<keyof AuditEvent>) {
    if (ALLOWED_FIELDS.has(k) && event[k] !== undefined) {
      record[k] = event[k];
    }
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(record));

  // Feed observability metrics for timed operations (fire-and-forget, never throws).
  // Dynamic import so the metrics module (which pulls in ioredis, a Node-only
  // dependency) is NEVER bundled into the edge middleware — auditLog is reached
  // from the middleware via @/auth, and a static import of ioredis there crashes
  // the edge runtime. Timed events only originate in Node route handlers anyway.
  if (typeof event.ms === "number") {
    const ms = event.ms;
    void import("@/lib/observability/metrics")
      .then((m) => m.recordRequest(event.action, event.ok, ms))
      .catch(() => { /* observability must never break a request */ });
  }
}
