import { defineConfig, devices } from "@playwright/test";

const localBrowser = process.env.PLAYWRIGHT_EXECUTABLE_PATH;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results/playwright",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: "http://localhost:3400",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{
    name: "chromium",
    use: {
      ...devices["Desktop Chrome"],
      ...(localBrowser ? { launchOptions: { executablePath: localBrowser } } : {}),
    },
  }],
  webServer: {
    command: process.env.CI ? "npm start" : "npm run build && npm start",
    url: "http://localhost:3400/verify",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      DACS_DIRECTORY_DATA: "test/e2e-data",
    },
  },
});
