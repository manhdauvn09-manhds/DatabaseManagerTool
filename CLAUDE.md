# DBManager — Project Knowledge

> ⚠️ **GROUND TRUTH (2026-06-09)** — single source of truth. Mọi `.md`, `.html`,
> `deploy.config.example.json`, `deploy/nginx/setup-nginx-site.sh`, `docs/DEVELOPER_GUIDE.html`
> còn nhắc `62.238.28.106`/`prod-106` là phế liệu (server cũ đã xoá 2026-06-04).

## Where things live

| | |
|---|---|
| Server | **mcp-80** = `65.108.62.80` |
| workDir | `/opt/dbmanager` |
| Branch | `main` (`gitPull: false`) |
| Containers | `dbmanager-app`, `dbmanager-redis` |
| App port | `9230` → container |
| Health | `http://127.0.0.1:9230/api/health` |
| Public | `https://DBManager.allin1site.com` |
| SSL | LE wildcard `allin1site-wildcard` |

## Data

⚠️ **2 volume QUAN TRỌNG**:
- `dbmanager_dbmanager_data` → mount `/data` chứa `saved-connections.json` (mã hoá AES).
  Mất volume = mất toàn bộ DB connection đã lưu của user.
- `dbmanager_dbmanager_redis` → AOF cho cache + session.

Cả 2 đã copy từ server cũ 2026-06-03. **KHÔNG recreate volume.**

## Deploy

```
MCP `deploy` { server_id: "mcp-80", app_id: "dbmanager" }
→ docker compose build --no-cache app + up -d app (KHÔNG đụng redis container)
```

## KHÔNG

- ❌ Chạy `deploy/nginx/setup-nginx-site.sh` — trỏ server cũ; host nginx đã có vhost rồi.
- ❌ Đụng 2 volume → mất data người dùng.
- ❌ Start container nginx riêng — sẽ giết host nginx + 12 site khác.

## Phế liệu — ignore
```
README.md (phần Server)
deploy.config.example.json
deploy/nginx/setup-nginx-site.sh
docs/DEVELOPER_GUIDE.html
```
