import { z } from "zod";

export const NameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9 _\-.()/]+$/, "Profile name contains invalid characters");

export const ProfileIdSchema = z.string().uuid();

// Plaintext connection payload the client sends. Server encrypts on the way in,
// decrypts on the way out — plaintext is never persisted.
export const PlainConnectionSchema = z.object({
  dbType: z.enum(["auto", "mysql", "postgresql", "mssql"]),
  host: z.string().min(1).max(253),
  port: z.coerce.number().int().min(1).max(65535),
  user: z.string().max(128).optional().default(""),
  password: z.string().max(1024),
  ssl: z.boolean().optional()
});
export type PlainConnection = z.infer<typeof PlainConnectionSchema>;

export const SaveProfileRequestSchema = z.object({
  name: NameSchema,
  data: PlainConnectionSchema
});
export type SaveProfileRequest = z.infer<typeof SaveProfileRequestSchema>;
