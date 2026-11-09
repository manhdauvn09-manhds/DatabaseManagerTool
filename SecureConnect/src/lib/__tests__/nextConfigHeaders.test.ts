import { describe, it, expect } from "vitest";
// @ts-expect-error - next.config.mjs is plain JS with no type declarations.
import nextConfig from "../../../next.config.mjs";

/**
 * Regression guard for the bug that took the whole JSON API down for ~4.5
 * months (2026-06-20 .. 2026-11-09, commit e6a8a84 "Performance improvements
 * (100x)").
 *
 * A static `Content-Encoding: gzip` header was declared for `/api/:path*`.
 * Next.js emitted it on every API response while the body stayed plain JSON,
 * so browsers aborted with ERR_CONTENT_DECODING_FAILED and sign-in never
 * reached Google. `curl` without --compressed ignores the header, which is
 * why both the health check and a manual curl kept reporting "fine".
 *
 * Content-Encoding is a transport concern: whoever compresses the bytes sets
 * it (Next via `compress: true`, or the proxy). It must never be a static
 * header, because a static value cannot know what the body actually is.
 */
describe("next.config headers", () => {
  const TRANSPORT_HEADERS = ["content-encoding", "transfer-encoding", "content-length"];

  it("declares no static transport-encoding header on any route", async () => {
    const routes = await nextConfig.headers();
    const offenders: string[] = [];

    for (const route of routes) {
      for (const h of route.headers) {
        if (TRANSPORT_HEADERS.includes(h.key.toLowerCase())) {
          offenders.push(`${route.source} -> ${h.key}: ${h.value}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("still sends no-store cache headers on /api routes", async () => {
    const routes = await nextConfig.headers();
    const api = routes.find((r: { source: string }) => r.source === "/api/:path*");

    expect(api, "the /api/:path* header rule must exist").toBeDefined();
    const cacheControl = api.headers.find(
      (h: { key: string }) => h.key.toLowerCase() === "cache-control"
    );
    expect(cacheControl?.value).toContain("no-store");
  });

  it("keeps the security headers on every route", async () => {
    const routes = await nextConfig.headers();
    const all = routes.find((r: { source: string }) => r.source === "/:path*");

    const keys = all.headers.map((h: { key: string }) => h.key.toLowerCase());
    expect(keys).toContain("content-security-policy");
    expect(keys).toContain("strict-transport-security");
    expect(keys).toContain("x-content-type-options");
  });
});
