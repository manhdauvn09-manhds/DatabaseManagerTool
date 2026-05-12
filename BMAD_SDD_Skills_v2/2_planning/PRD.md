# PRD — DatabaseManager (v2)

## Overview
FE tool cho member sign-in Google, connect DB an toàn qua embedded API.

## FR
- FR1: Sign-in required.
- FR2: Secure connect uses passwordEncrypted + keyId.

## NFR (security)
- HTTPS required in production
- No secret persistence

## Acceptance Criteria
- Unauth user cannot access /app or /api.
- Connect payload never sends raw password.
