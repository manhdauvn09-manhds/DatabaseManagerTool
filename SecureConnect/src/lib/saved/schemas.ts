import { z } from "zod";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// Base64 of 16 raw bytes ≈ 24 chars; 12 bytes ≈ 16 chars. Ciphertext: cap 6 KiB base64.
const SALT_RE = /^[A-Za-z0-9+/]{22,32}={0,2}$/;     // 16 bytes
const IV_RE = /^[A-Za-z0-9+/]{14,24}={0,2}$/;       // 12 bytes
const CIPHERTEXT_MAX = 6 * 1024;

export const KdfSchema = z.object({
  name: z.literal("PBKDF2"),
  hash: z.literal("SHA-256"),
  iterations: z.number().int().min(100_000).max(2_000_000)
});

export const NameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9 _\-.()/]+$/, "Profile name contains invalid characters");

export const SaveProfileSchema = z.object({
  name: NameSchema,
  salt: z.string().regex(SALT_RE, "Invalid salt (must be base64 of 16 bytes)"),
  iv: z.string().regex(IV_RE, "Invalid iv (must be base64 of 12 bytes)"),
  ciphertext: z.string().regex(BASE64).max(CIPHERTEXT_MAX),
  kdf: KdfSchema
});

export type SaveProfileInput = z.infer<typeof SaveProfileSchema>;

export const ProfileIdSchema = z.string().uuid();
