import { z } from "zod";

// Allow letters, digits, dot, hyphen, colon (for IPv6), brackets. No shell metacharacters.
const HOST_REGEX = /^[a-zA-Z0-9.\-:[\]]+$/;

export const ConnectRequestSchema = z.object({
  dbType: z.enum(["auto", "mysql", "postgresql", "mssql"]),
  host: z
    .string()
    .min(1)
    .max(253)
    .regex(HOST_REGEX, "Host contains invalid characters"),
  port: z.coerce.number().int().min(1).max(65535),
  user: z.string().max(128).optional(),
  // RSA-OAEP 2048-bit ciphertext = 256 bytes raw → ~344 chars base64. Hard cap 1024 for safety margin.
  passwordEncrypted: z.string().min(1).max(1024),
  keyId: z.string().min(1).max(128),
  ssl: z.boolean().optional()
});

export type ConnectRequest = z.infer<typeof ConnectRequestSchema>;
