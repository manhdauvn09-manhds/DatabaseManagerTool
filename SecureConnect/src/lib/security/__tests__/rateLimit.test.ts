import { describe, test, expect, beforeEach } from "vitest";
import { rateLimit, resetRateLimit, getClientIp } from "../rateLimit";

describe("rateLimit", () => {
  beforeEach(() => resetRateLimit());

  test("allows up to limit", () => {
    for (let i = 0; i < 5; i++) {
      const r = rateLimit("a", 5, 60_000);
      expect(r.ok).toBe(true);
    }
  });

  test("blocks after limit reached", () => {
    for (let i = 0; i < 5; i++) rateLimit("b", 5, 60_000);
    const r = rateLimit("b", 5, 60_000);
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.retryAfter).toBeGreaterThan(0);
    }
  });

  test("isolates keys", () => {
    for (let i = 0; i < 3; i++) rateLimit("c1", 3, 60_000);
    expect(rateLimit("c1", 3, 60_000).ok).toBe(false);
    expect(rateLimit("c2", 3, 60_000).ok).toBe(true);
  });

  test("recovers after window passes", async () => {
    for (let i = 0; i < 3; i++) rateLimit("d", 3, 50);
    expect(rateLimit("d", 3, 50).ok).toBe(false);
    await new Promise((res) => setTimeout(res, 80));
    expect(rateLimit("d", 3, 50).ok).toBe(true);
  });

  test("reset clears specific key", () => {
    for (let i = 0; i < 5; i++) rateLimit("e", 5, 60_000);
    expect(rateLimit("e", 5, 60_000).ok).toBe(false);
    resetRateLimit("e");
    expect(rateLimit("e", 5, 60_000).ok).toBe(true);
  });
});

describe("getClientIp", () => {
  function makeReq(headers: Record<string, string>): Request {
    return new Request("https://example.com/", { headers });
  }

  test("prefers cf-connecting-ip", () => {
    expect(getClientIp(makeReq({
      "cf-connecting-ip": "1.2.3.4",
      "x-forwarded-for": "9.9.9.9"
    }))).toBe("1.2.3.4");
  });

  test("falls back to first x-forwarded-for", () => {
    expect(getClientIp(makeReq({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }))).toBe("1.2.3.4");
  });

  test("falls back to x-real-ip", () => {
    expect(getClientIp(makeReq({ "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8");
  });

  test("unknown when no headers", () => {
    expect(getClientIp(makeReq({}))).toBe("unknown");
  });
});
