# Architecture — FE + Embedded API (v2)

## Pattern
Next.js app includes:
- UI routes (/signin, /app)
- API routes (/api/crypto/public-key, /api/connect)

## Secure Connect
- RSA-OAEP client encryption (WebCrypto)
- Decrypt server-side
- TTL-based in-memory connection record

## Notes
- Production deploy must enforce HTTPS.
- Multi-instance: consider stable key management (KMS/HSM) if needed.
