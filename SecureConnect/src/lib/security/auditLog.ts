import { recordRequest } from "@/lib/observability/metrics";

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
  if (typeof event.ms === "number") {
    recordRequest(event.action, event.ok, event.ms);
  }
}
