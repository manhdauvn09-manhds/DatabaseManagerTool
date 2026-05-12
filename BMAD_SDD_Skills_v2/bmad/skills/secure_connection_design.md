# Skill: secure_connection_design

## Purpose
Thiết kế secure connect flow (defense-in-depth).

## Inputs
- PRD
- security requirements

## Outputs
- update 1_spec/security_privacy_spec.md
- update 1_spec/api_contract.md
- update 2_planning/architecture_frontend.md

## Steps
1) Define HTTPS requirement
2) Add GET /api/crypto/public-key
3) Add passwordEncrypted + keyId to POST /api/connect
4) Define server decrypt + in-memory TTL
5) Add key rotation behavior

