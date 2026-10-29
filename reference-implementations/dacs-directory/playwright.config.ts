import { defineConfig, devices } from "@playwright/test";

// No chain service participates in browser regression tests.
const directoryUrl = "http://localhost:3400";
const unavailableChain = new URL(directoryUrl);
unavailableChain.port = "0";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results/playwright",
  fullyParallel: false,
  workers: 2,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: directoryUrl,
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
    url: directoryUrl,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_DIRECTORY_URL: directoryUrl,
      DEMOS_RPC: unavailableChain.href,
      DACS_ADMIN_TOKEN: "offline-browser-test",
      DACS_DIRECTORY_DATA: "test-results/browser-data",
    },
  },
});
