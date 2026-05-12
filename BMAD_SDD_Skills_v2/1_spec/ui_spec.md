# UI Spec — DatabaseManager (v2)

## Pages
- /signin: Google sign-in
- /app: Connect UI

## Connect form fields
- dbType, host, port, user(optional), password

## Behavior
- On Connect: fetch public key → encrypt password → clear password → call /api/connect
- Show success with connectionId
- Show error (KEY_ROTATED, CONNECT_FAIL, etc.)
