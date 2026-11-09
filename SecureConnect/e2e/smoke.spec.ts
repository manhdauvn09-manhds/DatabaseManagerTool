import { test, expect } from "@playwright/test";

/**
 * Smoke tests for the unauthenticated surface. These would have caught both
 * production incidents we hit: the ThemeProvider white-screen crash and the
 * BOM-broken signin. They assert the shell renders, no client exception fires,
 * and auth-gated routes redirect correctly.
 */

test("health endpoint returns ok", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
});

/**
 * Browser-side fetch of the JSON API.
 *
 * `request.get()` above is a Node-side HTTP client and is NOT equivalent: it
 * let a total API outage through for ~4.5 months. A static
 * `Content-Encoding: gzip` header on /api/* made every JSON response
 * undecodable in a real browser (ERR_CONTENT_DECODING_FAILED) while curl,
 * wget, the Docker HEALTHCHECK and Playwright's request context all still
 * reported 200 — they ignore the header or never decompress.
 *
 * Only a fetch() from inside a page walks the same path as the user's browser,
 * so the API contract has to be asserted from there.
 */
test("JSON API decodes in a real browser, not just in curl", async ({ page }) => {
  await page.goto("/signin");

  const results = await page.evaluate(async () => {
    const paths = ["/api/health", "/api/auth/providers", "/api/auth/csrf", "/api/auth/session"];
    const out: Array<{ path: string; status?: number; encoding: string | null; readable: boolean; error?: string }> = [];
    for (const path of paths) {
      try {
        const res = await fetch(path, { cache: "no-store" });
        const encoding = res.headers.get("content-encoding");
        try {
          await res.text();
          out.push({ path, status: res.status, encoding, readable: true });
        } catch (e) {
          out.push({ path, status: res.status, encoding, readable: false, error: String(e) });
        }
      } catch (e) {
        out.push({ path, encoding: null, readable: false, error: String(e) });
      }
    }
    return out;
  });

  const unreadable = results.filter((r) => !r.readable);
  expect(
    unreadable,
    `body did not decode in-browser: ${JSON.stringify(unreadable, null, 2)}`
  ).toHaveLength(0);
});

test("clicking sign-in reaches Google, not the auth error page", async ({ page }) => {
  // The real regression: signIn() fetches /api/auth/providers first. When that
  // fetch dies, next-auth/react redirects to /api/auth/error and the user never
  // sees Google at all. Assert we leave for the OAuth provider instead.
  await page.route("https://accounts.google.com/**", (route) =>
    route.fulfill({ status: 200, body: "stub-google" })
  );

  await page.goto("/signin");
  await page.getByRole("button", { name: /sign in with google/i }).click();
  await page.waitForURL(/accounts\.google\.com|\/api\/auth\/error/, { timeout: 15_000 });

  expect(page.url(), "sign-in bounced to the auth error page").not.toContain("/api/auth/error");
});

test("signin page renders the Google button and does not crash", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/signin");

  // The Next.js production error boundary renders this text on a client crash.
  await expect(page.locator("body")).not.toContainText("Application error");
  await expect(page.getByRole("button", { name: /sign in with google/i })).toBeVisible();

  expect(errors, `client exceptions: ${errors.join(", ")}`).toHaveLength(0);
});

test("anti-FOUC theme script sets data-theme before paint", async ({ page }) => {
  await page.goto("/signin");
  const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  expect(theme === "light" || theme === "dark").toBeTruthy();
});

test("unauthenticated /app redirects to signin", async ({ page }) => {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/signin/);
  await expect(page.getByRole("button", { name: /sign in with google/i })).toBeVisible();
});

test("documentation pages are served", async ({ request }) => {
  for (const path of ["/user-manual.html", "/features.html"]) {
    const res = await request.get(path);
    expect(res.status(), `${path} should be 200`).toBe(200);
    expect(await res.text()).toContain("DatabaseManager");
  }
});

test("public docs do not leak infrastructure details", async ({ request }) => {
  const res = await request.get("/features.html");
  const html = await res.text();
  // Guard against re-introducing server IP / internal paths on the public page.
  expect(html).not.toContain("65.108.62.80");
  expect(html).not.toContain("/opt/dbmanager");
  expect(html).not.toContain("ssh root@");
});
