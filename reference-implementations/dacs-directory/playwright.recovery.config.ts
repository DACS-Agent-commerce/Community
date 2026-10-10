import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results/playwright-recovery",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3401",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx next dev -p 3401",
    url: "http://localhost:3401/try",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_DIRECTORY_URL: "http://localhost:3401",
      NEXT_PUBLIC_BUTLER_ORIGIN: "https://butler.agentcommerce.network",
      NEXT_PUBLIC_GATEWAY_DEMO_RECOVERY_ONLY: "1",
    },
  },
});
