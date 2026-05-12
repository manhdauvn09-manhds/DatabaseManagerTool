# API Contract (Frontend-facing) — DatabaseManager (v2)

## Auth
- All endpoints require authenticated session.

## Crypto
### GET /api/crypto/public-key
Response:
```json
{ "keyId": "...", "publicJwk": { /* JWK */ } }
```

## Connect
### POST /api/connect
Request:
```json
{
  "dbType": "auto|mysql|postgresql|mssql",
  "host": "...",
  "port": 3306,
  "user": "...",
  "passwordEncrypted": "base64",
  "keyId": "..."
}
```
Response:
```json
{ "connectionId": "...", "dbType": "mysql|postgresql|mssql" }
```

## Errors
```json
{ "error": { "code": "...", "message": "...", "details": {} } }
```
