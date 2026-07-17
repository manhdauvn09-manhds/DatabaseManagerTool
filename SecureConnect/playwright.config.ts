import { defineConfig, devices } from "@playwright/test";

/**
 * E2E smoke tests. They boot the production server with throwaway auth secrets
 * and assert the app shell renders / redirects correctly — the class of bug
 * (white-screen crash, broken signin) that unit tests can't catch.
 *
 * No real Google OAuth is exercised; tests cover the unauthenticated surface.
 */
const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry"
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // `next start` serves the production build; env is inherited from below.
    command: `npm run start`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PORT: String(PORT),
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      // Throwaway secrets so the server boots; no real OAuth is performed.
      AUTH_SECRET: "dGVzdC1zZWNyZXQtZm9yLWUyZS1zbW9rZS10ZXN0cy1vbmx5MTIz",
      AUTH_GOOGLE_ID: "e2e-test.apps.googleusercontent.com",
      AUTH_GOOGLE_SECRET: "e2e-test-secret",
      AUTH_URL: BASE_URL,
      AUTH_TRUST_HOST: "true",
      AUTH_ALLOW_ANY: "true"
    }
  }
});
