import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for motionmax E2E tests.
 *
 * webServer: spins up `npm run dev` (vite on :8080) before tests run, unless
 * a server is already listening (local dev convenience). In CI we always
 * spin up fresh — `reuseExistingServer: false` is enforced via CI env var.
 *
 * test-Supabase isolation:
 *   E2E tests MUST NOT hit the production Supabase project. Two modes are
 *   supported, controlled by TEST_SUPABASE_MODE:
 *
 *     1. local      (default in CI) — `supabase start --no-studio` boots a
 *        full local Supabase stack on :54321. Tests use TEST_SUPABASE_URL
 *        and TEST_SUPABASE_ANON_KEY env vars, which point at it.
 *
 *     2. shadow     — uses a dedicated Supabase TEST project
 *        (islqnpbdkfbaexwtuppt). CI populates TEST_SUPABASE_URL +
 *        TEST_SUPABASE_ANON_KEY from secrets. Slower, costs money, but
 *        useful for shaking out edge-function deploys before prod.
 *
 *   See e2e/README.md for setup details.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["html", { open: "never" }], ["github"]]
    : "html",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.BASE_URL || "http://localhost:8080",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    // `npm run dev` boots vite on :8080 (see vite.config.ts).
    // CI swaps this for `npm run preview` against a built bundle to
    // catch any build-only regressions; controlled via E2E_USE_PREVIEW.
    command: process.env.E2E_USE_PREVIEW
      ? "npm run preview -- --port 8080"
      : "npm run dev",
    url: process.env.BASE_URL || "http://localhost:8080",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      // Force the frontend to point at the test Supabase, never prod.
      // The values come from the CI environment (set by the e2e job)
      // or the developer's .env.test for local runs.
      VITE_SUPABASE_URL:
        process.env.TEST_SUPABASE_URL || "http://localhost:54321",
      VITE_SUPABASE_ANON_KEY:
        process.env.TEST_SUPABASE_ANON_KEY || "test-anon-key",
      VITE_E2E: "1",
    },
  },
});
