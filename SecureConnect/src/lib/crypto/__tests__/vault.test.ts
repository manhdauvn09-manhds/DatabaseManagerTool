import { describe, test, expect } from "vitest";
import { encryptPayload, decryptPayload } from "../vault";

describe("vault round-trip", () => {
  test("encrypt then decrypt with same passphrase returns original payload", async () => {
    const payload = { host: "db.example.com", port: 3306, user: "root", password: "s3cret", dbType: "mysql" };
    const blob = await encryptPayload("strong-passphrase-1", payload);
    const back = await decryptPayload<typeof payload>("strong-passphrase-1", blob);
    expect(back).toEqual(payload);
  });

  test("rejects wrong passphrase", async () => {
    const blob = await encryptPayload("correct-pass-1", { a: 1 });
    await expect(decryptPayload("wrong-pass-1", blob)).rejects.toThrow(/Decrypt failed/);
  });

  test("rejects short passphrase on encrypt", async () => {
    await expect(encryptPayload("short", {})).rejects.toThrow(/at least 8/);
  });

  test("blob fields are base64 and KDF params present", async () => {
    const blob = await encryptPayload("passphrase!", { x: "y" });
    expect(blob.kdf.iterations).toBeGreaterThanOrEqual(100_000);
    expect(blob.kdf.name).toBe("PBKDF2");
    expect(blob.kdf.hash).toBe("SHA-256");
    expect(blob.salt).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(blob.iv).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(blob.ciphertext).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });
});
