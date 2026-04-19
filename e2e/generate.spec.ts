import { expect, test } from "@playwright/test";

const TEST_EMAIL = process.env.TEST_EMAIL || "e2e-test@motionmax.dev";
const TEST_PASSWORD = process.env.TEST_PASSWORD || "E2E_Test_Password_123!";

// Log in before each test in this suite
test.beforeEach(async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(TEST_EMAIL);
  await page.getByLabel(/password/i).fill(TEST_PASSWORD);
  await page.getByRole("button", { name: /log in|sign in/i }).click();
  await page.waitForURL(/dashboard/, { timeout: 10_000 });
});

test.describe("Project creation and generation", () => {
  test("authenticated user can create a new project", async ({ page }) => {
    // Find and click the new-project CTA — update selector to match actual UI
    await page.getByRole("button", { name: /new project|create project|\+/i }).click();

    // Fill in project details in the creation form/modal
    const projectName = `E2E Test ${Date.now()}`;
    const nameField = page.getByLabel(/project name|title/i);
    await nameField.fill(projectName);

    await page.getByRole("button", { name: /create|save|continue/i }).click();

    // Should navigate to the new project or show it in the dashboard
    await expect(page.getByText(projectName)).toBeVisible({ timeout: 10_000 });
  });

  test("created project appears in the dashboard", async ({ page }) => {
    const projectName = `Dashboard E2E ${Date.now()}`;

    await page.getByRole("button", { name: /new project|create project|\+/i }).click();
    await page.getByLabel(/project name|title/i).fill(projectName);
    await page.getByRole("button", { name: /create|save|continue/i }).click();

    // Navigate back to dashboard and confirm the project is listed
    await page.goto("/dashboard");
    await expect(page.getByText(projectName)).toBeVisible({ timeout: 10_000 });
  });

  test("generation can be initiated from a project", async ({ page }) => {
    // Create a project first
    await page.getByRole("button", { name: /new project|create project|\+/i }).click();
    await page.getByLabel(/project name|title/i).fill(`Gen E2E ${Date.now()}`);
    await page.getByRole("button", { name: /create|save|continue/i }).click();

    // Fill in the generation form — update selectors to match actual UI fields
    const topicField = page.getByLabel(/topic|script|content/i).first();
    if (await topicField.isVisible()) {
      await topicField.fill("A short test video about space exploration");
    }

    // Click generate / initiate
    const generateBtn = page.getByRole("button", {
      name: /generate|create video|start/i,
    });
    await expect(generateBtn).toBeVisible({ timeout: 5_000 });

    // Verify the button is enabled (user has credits / valid subscription)
    await expect(generateBtn).toBeEnabled();

    // Click and verify the UI transitions to a "generating" or "processing" state.
    // We don't wait for actual video generation — just confirm the request was accepted.
    await generateBtn.click();

    await expect(
      page.getByText(/generating|processing|queued|in progress/i),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("generation button is disabled when user has insufficient credits", async ({ page }) => {
    // This test relies on the test account having 0 credits.
    // Skip if credits cannot be controlled from E2E tests.
    test.skip(
      !process.env.TEST_ZERO_CREDIT_EMAIL,
      "Requires TEST_ZERO_CREDIT_EMAIL env var pointing to a 0-credit account",
    );

    await page.goto("/login");
    await page.getByLabel(/email/i).fill(process.env.TEST_ZERO_CREDIT_EMAIL!);
    await page.getByLabel(/password/i).fill(TEST_PASSWORD);
    await page.getByRole("button", { name: /log in|sign in/i }).click();
    await page.waitForURL(/dashboard/, { timeout: 10_000 });

    await page.getByRole("button", { name: /new project|create project|\+/i }).click();

    const generateBtn = page.getByRole("button", {
      name: /generate|create video|start/i,
    });
    if (await generateBtn.isVisible()) {
      await expect(generateBtn).toBeDisabled();
    }
  });
});
