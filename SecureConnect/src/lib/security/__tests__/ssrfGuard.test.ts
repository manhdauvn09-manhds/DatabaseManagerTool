import { describe, test, expect } from "vitest";
import {
  isForbiddenIPv4,
  isPrivateIPv4,
  isForbiddenIPv6,
  isPrivateIPv6,
  ensureSafeHost
} from "../ssrfGuard";

describe("isForbiddenIPv4", () => {
  test("loopback /8", () => {
    expect(isForbiddenIPv4("127.0.0.1")).toBe(true);
    expect(isForbiddenIPv4("127.255.255.255")).toBe(true);
  });
  test("cloud metadata 169.254/16", () => {
    expect(isForbiddenIPv4("169.254.169.254")).toBe(true);
    expect(isForbiddenIPv4("169.254.0.1")).toBe(true);
  });
  test("unspecified 0.0.0.0/8", () => {
    expect(isForbiddenIPv4("0.0.0.0")).toBe(true);
  });
  test("multicast 224.0.0.0/4", () => {
    expect(isForbiddenIPv4("224.0.0.1")).toBe(true);
  });
  test("public IPs not forbidden", () => {
    expect(isForbiddenIPv4("8.8.8.8")).toBe(false);
    expect(isForbiddenIPv4("1.1.1.1")).toBe(false);
    expect(isForbiddenIPv4("10.0.0.1")).toBe(false);
  });
  test("invalid input", () => {
    expect(isForbiddenIPv4("not.an.ip")).toBe(false);
    expect(isForbiddenIPv4("256.0.0.1")).toBe(false);
    expect(isForbiddenIPv4("")).toBe(false);
  });
});

describe("isPrivateIPv4 (RFC1918)", () => {
  test("10.0.0.0/8", () => {
    expect(isPrivateIPv4("10.0.0.1")).toBe(true);
    expect(isPrivateIPv4("10.255.255.255")).toBe(true);
  });
  test("172.16.0.0/12", () => {
    expect(isPrivateIPv4("172.16.0.1")).toBe(true);
    expect(isPrivateIPv4("172.31.255.255")).toBe(true);
    expect(isPrivateIPv4("172.32.0.1")).toBe(false);
    expect(isPrivateIPv4("172.15.0.1")).toBe(false);
  });
  test("192.168.0.0/16", () => {
    expect(isPrivateIPv4("192.168.1.1")).toBe(true);
    expect(isPrivateIPv4("192.168.255.255")).toBe(true);
    expect(isPrivateIPv4("192.169.0.1")).toBe(false);
  });
  test("public not private", () => {
    expect(isPrivateIPv4("8.8.8.8")).toBe(false);
    expect(isPrivateIPv4("127.0.0.1")).toBe(false);
  });
});

describe("IPv6", () => {
  test("loopback forbidden", () => {
    expect(isForbiddenIPv6("::1")).toBe(true);
    expect(isForbiddenIPv6("::")).toBe(true);
  });
  test("mapped IPv4 inherits IPv4 rules", () => {
    expect(isForbiddenIPv6("::ffff:127.0.0.1")).toBe(true);
    expect(isForbiddenIPv6("::ffff:8.8.8.8")).toBe(false);
  });
  test("ULA fc00::/7 private", () => {
    expect(isPrivateIPv6("fc00::1")).toBe(true);
    expect(isPrivateIPv6("fd00::1")).toBe(true);
    expect(isPrivateIPv6("fe00::1")).toBe(false);
  });
  test("link-local fe80::/10 private", () => {
    expect(isPrivateIPv6("fe80::1")).toBe(true);
    expect(isPrivateIPv6("febf::1")).toBe(true);
    expect(isPrivateIPv6("fec0::1")).toBe(false);
  });
  test("public IPv6 not private/forbidden", () => {
    expect(isPrivateIPv6("2001:4860:4860::8888")).toBe(false);
    expect(isForbiddenIPv6("2001:4860:4860::8888")).toBe(false);
  });
});

describe("ensureSafeHost", () => {
  test("IPv4 literal: loopback blocked", async () => {
    const r = await ensureSafeHost("127.0.0.1");
    expect(r.ok).toBe(false);
  });
  test("IPv4 literal: cloud metadata always blocked even with allowPrivate", async () => {
    const r = await ensureSafeHost("169.254.169.254", { allowPrivate: true });
    expect(r.ok).toBe(false);
  });
  test("IPv4 literal: RFC1918 blocked by default", async () => {
    const r = await ensureSafeHost("10.0.0.1");
    expect(r.ok).toBe(false);
  });
  test("IPv4 literal: RFC1918 allowed with allowPrivate=true", async () => {
    const r = await ensureSafeHost("10.0.0.1", { allowPrivate: true });
    expect(r.ok).toBe(true);
  });
  test("IPv4 literal: public address OK", async () => {
    const r = await ensureSafeHost("8.8.8.8");
    expect(r.ok).toBe(true);
  });
  test("invalid host", async () => {
    const r = await ensureSafeHost("");
    expect(r.ok).toBe(false);
  });
  test("very long host rejected", async () => {
    const r = await ensureSafeHost("a".repeat(300));
    expect(r.ok).toBe(false);
  });
});
