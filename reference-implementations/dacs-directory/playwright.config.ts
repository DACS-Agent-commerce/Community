import { defineConfig, devices } from "@playwright/test";

const butlerOrigin = process.env.LIVE_BUTLER_ORIGIN ?? "https://butler.agentcommerce.network";
const livePaidRun = process.env.RUN_LIVE_PAID_E2E === "1";

export default defineConfig({
  testDir: "./e2e",
  outputDir: livePaidRun ? "test-results/playwright-live" : "test-results/playwright",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: livePaidRun ? 1 : undefined,
  reporter: [["list"], ["html", { open: "never", outputFolder: livePaidRun ? "playwright-report-live" : "playwright-report" }]],
  use: {
    baseURL: "http://localhost:3400",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3400/try",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_DIRECTORY_URL: "http://localhost:3400",
      NEXT_PUBLIC_BUTLER_ORIGIN: butlerOrigin,
    },
  },
});
