# dbm — DatabaseManager CLI

Zero-dependency Node CLI (Node ≥ 18) for DatabaseManager. Authenticates with a
Personal Access Token (PAT) and acts as the token's owner.

## Install

```bash
cd cli
npm link        # or: npm install -g .
# or just run directly:
node dbm.mjs help
```

## Setup

1. Open the web app → **API Tokens** → create a token (copy it once).
2. Export it:

```bash
export DBM_TOKEN="dbm_pat_xxxxxxxx..."
export DBM_URL="https://DBManager.allin1site.com"   # optional (default)
```

## Commands

```bash
# Connect (password is RSA-OAEP encrypted in-process before sending; omit --password to be prompted)
dbm connect --type mysql --host db.example.com --port 3306 --user root --password secret
# → { "connectionId": "....", "dbType": "mysql" }

dbm databases --cid <connectionId>
dbm tables    --cid <id> --database mydb
dbm columns   --cid <id> --database mydb --table users
dbm rows      --cid <id> --database mydb --table users --limit 20 --offset 0
dbm query     --cid <id> --sql "SELECT count(*) AS n FROM mydb.users"
```

All output is JSON on stdout; errors go to stderr with a non-zero exit code.

## Notes

- **Read-only `query`**: only `SELECT` / `EXPLAIN` / `WITH` / `SHOW` / `DESC` /
  `PRAGMA` are accepted (enforced server-side). Writes are rejected.
- A connection (`--cid`) is server-side state with a sliding TTL (~30 min, 2 h
  hard cap). Re-run `dbm connect` when it expires.
- The PAT acts as you. Treat it like a password; revoke it in the web UI if leaked.
- CSRF/Origin checks don't apply to token auth (bearer tokens aren't sent
  automatically by browsers).
