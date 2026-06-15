#!/usr/bin/env node
/**
 * dbm — DatabaseManager CLI (zero dependencies).
 *
 * Auth: a Personal Access Token (create one in the web UI → API Tokens).
 *   export DBM_TOKEN="dbm_pat_..."
 *   export DBM_URL="https://DBManager.allin1site.com"   # optional, this is the default
 *
 * Read-only by design from the CLI's perspective (query is SELECT/EXPLAIN-only,
 * enforced server-side). Connect/browse/query all act as the token's owner.
 *
 * Examples:
 *   dbm connect --type mysql --host db.example.com --port 3306 --user root --password secret
 *   dbm databases --cid <connectionId>
 *   dbm tables    --cid <id> --database mydb
 *   dbm columns   --cid <id> --database mydb --table users
 *   dbm rows      --cid <id> --database mydb --table users --limit 20
 *   dbm query     --cid <id> --sql "SELECT count(*) FROM mydb.users"
 */
import { webcrypto } from "node:crypto";
import { createInterface } from "node:readline";

const BASE = (process.env.DBM_URL || "https://DBManager.allin1site.com").replace(/\/+$/, "");
const TOKEN = process.env.DBM_TOKEN || "";

function die(msg, code = 1) {
  process.stderr.write(`dbm: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) { out[key] = true; }
      else { out[key] = next; i++; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function api(path, { method = "GET", body } = {}) {
  if (!TOKEN) die("DBM_TOKEN is not set. Create one in the web UI → API Tokens.");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const code = json?.error?.code ? `${json.error.code}: ` : "";
    die(`${code}${json?.error?.message ?? `HTTP ${res.status}`}`, 2);
  }
  return json;
}

async function readPasswordInteractive() {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question("DB password: ", (answer) => { rl.close(); resolve(answer); });
    // Best-effort masking.
    const stdout = process.stdout;
    rl._writeToOutput = () => stdout.write("");
  });
}

async function encryptPassword(password, publicJwk) {
  const key = await webcrypto.subtle.importKey(
    "jwk", publicJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]
  );
  const ct = await webcrypto.subtle.encrypt({ name: "RSA-OAEP" }, key, new TextEncoder().encode(password));
  return Buffer.from(new Uint8Array(ct)).toString("base64");
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

const HELP = `dbm — DatabaseManager CLI

Usage:
  dbm connect   --type <auto|mysql|postgresql|mssql> --host H --port P [--user U] [--password PW] [--ssl]
  dbm databases --cid <id>
  dbm tables    --cid <id> --database DB
  dbm columns   --cid <id> --database DB --table T
  dbm rows      --cid <id> --database DB --table T [--limit N] [--offset N]
  dbm query     --cid <id> --sql "SELECT ..."        (read-only: SELECT/EXPLAIN/WITH/SHOW)
  dbm help

Env:
  DBM_TOKEN   Personal access token (required) — web UI → API Tokens
  DBM_URL     Base URL (default https://DBManager.allin1site.com)
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  switch (cmd) {
    case undefined:
    case "help":
      process.stdout.write(HELP);
      return;

    case "connect": {
      if (!args.host || !args.port) die("connect requires --host and --port");
      const password = typeof args.password === "string" ? args.password : await readPasswordInteractive();
      if (!password) die("password required");
      const pk = await api("/api/crypto/public-key");
      const passwordEncrypted = await encryptPassword(password, pk.publicJwk);
      const res = await api("/api/connect", {
        method: "POST",
        body: {
          dbType: args.type || "auto",
          host: args.host,
          port: Number(args.port),
          user: args.user || undefined,
          passwordEncrypted,
          keyId: pk.keyId,
          ssl: args.ssl ? true : undefined
        }
      });
      out(res);
      return;
    }

    case "databases":
      if (!args.cid) die("--cid required");
      out(await api(`/api/db/${args.cid}/databases`));
      return;

    case "tables":
      if (!args.cid || !args.database) die("--cid and --database required");
      out(await api(`/api/db/${args.cid}/tables?database=${encodeURIComponent(args.database)}`));
      return;

    case "columns":
      if (!args.cid || !args.database || !args.table) die("--cid, --database, --table required");
      out(await api(`/api/db/${args.cid}/columns?database=${encodeURIComponent(args.database)}&table=${encodeURIComponent(args.table)}`));
      return;

    case "rows": {
      if (!args.cid || !args.database || !args.table) die("--cid, --database, --table required");
      const limit = args.limit ? Number(args.limit) : 50;
      const offset = args.offset ? Number(args.offset) : 0;
      out(await api(`/api/db/${args.cid}/rows?database=${encodeURIComponent(args.database)}&table=${encodeURIComponent(args.table)}&limit=${limit}&offset=${offset}`));
      return;
    }

    case "query":
      if (!args.cid || !args.sql) die("--cid and --sql required");
      out(await api(`/api/db/${args.cid}/query`, { method: "POST", body: { sql: String(args.sql), limit: args.limit ? Number(args.limit) : 1000 } }));
      return;

    default:
      die(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
