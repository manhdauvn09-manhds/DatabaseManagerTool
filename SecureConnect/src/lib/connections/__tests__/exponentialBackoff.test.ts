import { describe, test, expect, vi } from "vitest";
import { withExponentialBackoff } from "../exponentialBackoff";

describe("exponentialBackoff", () => {
  test("succeeds on first attempt", async () => {
    const fn = vi.fn().mockResolvedValueOnce("success");
    const result = await withExponentialBackoff(fn);
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledOnce();
  });

  test("retries on transient ECONNREFUSED error", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED: connect ECONNREFUSED"))
      .mockResolvedValueOnce("success");

    const result = await withExponentialBackoff(fn, { maxAttempts: 3, maxDelayMs: 100 });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("retries on ETIMEDOUT", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce("ok");

    const result = await withExponentialBackoff(fn, { maxAttempts: 4, maxDelayMs: 50 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("fails on non-transient error (no retry)", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("Invalid query syntax"));
    await expect(
      withExponentialBackoff(fn, { maxAttempts: 5 })
    ).rejects.toThrow("Invalid query syntax");
    expect(fn).toHaveBeenCalledOnce();
  });

  test("fails after max attempts reached", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await expect(
      withExponentialBackoff(fn, { maxAttempts: 3, maxDelayMs: 50 })
    ).rejects.toThrow("ECONNREFUSED");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("returns correct value type", async () => {
    const fn = vi.fn().mockResolvedValueOnce({ data: [1, 2, 3] });
    const result = await withExponentialBackoff(fn);
    expect(result).toEqual({ data: [1, 2, 3] });
  });
});
