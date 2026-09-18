import { defineConfig } from "@playwright/test";

// One headless Chromium, one test, no retries: a retry would hide a flaky
// click, and this suite exists to say whether the click works.
export default defineConfig({
  testDir: ".",
  testMatch: "*.e2e.ts",
  outputDir: "../../test-results/dashboard",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    browserName: "chromium",
    headless: true,
    // Kept only when the test fails; CI uploads this folder in that case.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
