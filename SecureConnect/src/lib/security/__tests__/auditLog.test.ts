import { describe, test, expect, vi } from "vitest";
import { audit } from "../auditLog";

function captureLog(fn: () => void): string {
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    fn();
    expect(spy).toHaveBeenCalledTimes(1);
    return spy.mock.calls[0][0] as string;
  } finally {
    spy.mockRestore();
  }
}

describe("audit", () => {
  test("emits structured JSON with timestamp", () => {
    const line = captureLog(() =>
      audit({ action: "connect", email: "a@b.co", ip: "1.2.3.4", ok: true })
    );
    const obj = JSON.parse(line);
    expect(obj.action).toBe("connect");
    expect(obj.email).toBe("a@b.co");
    expect(obj.ip).toBe("1.2.3.4");
    expect(obj.ok).toBe(true);
    expect(typeof obj.ts).toBe("string");
    expect(new Date(obj.ts).toString()).not.toBe("Invalid Date");
  });

  test("drops unknown / sensitive fields if injected", () => {
    const line = captureLog(() =>
      // @ts-expect-error — intentionally inject an extra field to confirm whitelist
      audit({ action: "connect", email: "a@b.co", ok: true, password: "secret", passwordEncrypted: "xxx", keyId: "k" })
    );
    const obj = JSON.parse(line);
    expect("password" in obj).toBe(false);
    expect("passwordEncrypted" in obj).toBe(false);
    expect("keyId" in obj).toBe(false);
  });

  test("omits undefined fields", () => {
    const line = captureLog(() =>
      audit({ action: "connect", ok: false, errCode: "UNAUTH" })
    );
    const obj = JSON.parse(line);
    expect("email" in obj).toBe(false);
    expect("host" in obj).toBe(false);
    expect(obj.errCode).toBe("UNAUTH");
  });
});
