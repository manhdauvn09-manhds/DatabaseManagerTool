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
