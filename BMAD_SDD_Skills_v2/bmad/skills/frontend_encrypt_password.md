# Skill: frontend_encrypt_password

## Purpose
Thiết kế/implement mã hoá password ở browser bằng WebCrypto.

## Inputs
- publicJwk + keyId từ API

## Outputs
- FE code encrypt RSA-OAEP
- update story 002 checklist

## Steps
1) Fetch public key
2) Import key (RSA-OAEP SHA-256)
3) Encrypt password
4) Clear password from state
5) POST /api/connect with passwordEncrypted + keyId

