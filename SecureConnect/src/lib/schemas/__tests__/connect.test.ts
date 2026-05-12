import { describe, test, expect } from "vitest";
import { ConnectRequestSchema } from "../connect";

const VALID = {
  dbType: "mysql" as const,
  host: "db.example.com",
  port: 3306,
  user: "root",
  passwordEncrypted: "AAAA",
  keyId: "k-1"
};

describe("ConnectRequestSchema", () => {
  test("accepts a valid payload", () => {
    expect(ConnectRequestSchema.safeParse(VALID).success).toBe(true);
  });

  test("rejects port out of range", () => {
    expect(ConnectRequestSchema.safeParse({ ...VALID, port: 0 }).success).toBe(false);
    expect(ConnectRequestSchema.safeParse({ ...VALID, port: 70000 }).success).toBe(false);
  });

  test("rejects host with shell metacharacters", () => {
    expect(ConnectRequestSchema.safeParse({ ...VALID, host: "h;rm -rf" }).success).toBe(false);
    expect(ConnectRequestSchema.safeParse({ ...VALID, host: "h$(whoami)" }).success).toBe(false);
    expect(ConnectRequestSchema.safeParse({ ...VALID, host: "h`id`" }).success).toBe(false);
    expect(ConnectRequestSchema.safeParse({ ...VALID, host: "h|nc" }).success).toBe(false);
    expect(ConnectRequestSchema.safeParse({ ...VALID, host: "h with space" }).success).toBe(false);
  });

  test("accepts IPv4 + IPv6 host literals", () => {
    expect(ConnectRequestSchema.safeParse({ ...VALID, host: "10.0.0.1" }).success).toBe(true);
    expect(ConnectRequestSchema.safeParse({ ...VALID, host: "[2001:db8::1]" }).success).toBe(true);
  });

  test("rejects oversized passwordEncrypted (DoS guard)", () => {
    const big = "a".repeat(2000);
    expect(ConnectRequestSchema.safeParse({ ...VALID, passwordEncrypted: big }).success).toBe(false);
  });

  test("rejects unknown dbType", () => {
    expect(
      ConnectRequestSchema.safeParse({ ...VALID, dbType: "oracle" as unknown as "mysql" }).success
    ).toBe(false);
  });

  test("user optional", () => {
    const { user: _user, ...rest } = VALID;
    expect(ConnectRequestSchema.safeParse(rest).success).toBe(true);
  });

  test("coerces numeric strings for port", () => {
    const r = ConnectRequestSchema.safeParse({ ...VALID, port: "3306" as unknown as number });
    expect(r.success).toBe(true);
  });

  test("accepts optional ssl flag", () => {
    expect(ConnectRequestSchema.safeParse({ ...VALID, ssl: true }).success).toBe(true);
    expect(ConnectRequestSchema.safeParse({ ...VALID, ssl: false }).success).toBe(true);
  });

  test("rejects ssl with wrong type", () => {
    expect(
      ConnectRequestSchema.safeParse({ ...VALID, ssl: "yes" as unknown as boolean }).success
    ).toBe(false);
  });
});
