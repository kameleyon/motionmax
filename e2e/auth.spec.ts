import { expect, test } from "@playwright/test";

// Shared test credentials — use a dedicated test account, not a real user.
const TEST_EMAIL = process.env.TEST_EMAIL || "e2e-test@motionmax.dev";
const TEST_PASSWORD = process.env.TEST_PASSWORD || "E2E_Test_Password_123!";

test.describe("Authentication", () => {
  test("user can sign up with a new account", async ({ page }) => {
    await page.goto("/");

    // Navigate to sign-up — update selector to match actual UI
    await page.getByRole("link", { name: /sign up/i }).click();

    await page.getByLabel(/email/i).fill(`e2e-${Date.now()}@motionmax.dev`);
    await page.getByLabel(/password/i).fill(TEST_PASSWORD);
    await page.getByRole("button", { name: /sign up|create account/i }).click();

    // After sign-up the user should land on the dashboard or a confirm-email page
    await expect(
      page.getByRole("heading", { name: /dashboard|check your email/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("user can log in with valid credentials", async ({ page }) => {
    await page.goto("/login");

    await page.getByLabel(/email/i).fill(TEST_EMAIL);
    await page.getByLabel(/password/i).fill(TEST_PASSWORD);
    await page.getByRole("button", { name: /log in|sign in/i }).click();

    // Should redirect to dashboard after successful login
    await expect(page).toHaveURL(/dashboard/, { timeout: 10_000 });
  });

  test("user lands on dashboard after login", async ({ page }) => {
    await page.goto("/login");

    await page.getByLabel(/email/i).fill(TEST_EMAIL);
    await page.getByLabel(/password/i).fill(TEST_PASSWORD);
    await page.getByRole("button", { name: /log in|sign in/i }).click();

    await page.waitForURL(/dashboard/, { timeout: 10_000 });

    // Dashboard should show user-specific content
    await expect(
      page.getByRole("heading", { name: /dashboard|my projects|workspace/i }),
    ).toBeVisible();
  });

  test("invalid credentials show an error message", async ({ page }) => {
    await page.goto("/login");

    await page.getByLabel(/email/i).fill("nobody@nowhere.invalid");
    await page.getByLabel(/password/i).fill("wrong-password");
    await page.getByRole("button", { name: /log in|sign in/i }).click();

    await expect(
      page.getByText(/invalid|incorrect|failed|error/i),
    ).toBeVisible({ timeout: 8_000 });
  });

  test("authenticated user is redirected away from login page", async ({ page, context }) => {
    // Simulate an already-authenticated session via storage state if available
    await page.goto("/login");
    await page.getByLabel(/email/i).fill(TEST_EMAIL);
    await page.getByLabel(/password/i).fill(TEST_PASSWORD);
    await page.getByRole("button", { name: /log in|sign in/i }).click();
    await page.waitForURL(/dashboard/, { timeout: 10_000 });

    // Revisiting /login while authenticated should redirect back to dashboard
    await page.goto("/login");
    await expect(page).toHaveURL(/dashboard/, { timeout: 5_000 });
  });
});
