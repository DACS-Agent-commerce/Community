import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const dataDirectory = process.env.DACS_NO_RATE_TEST_DATA ??= mkdtempSync(join(tmpdir(), "dacs-no-rates-browser-"));
const networkGuard = fileURLToPath(new URL("./e2e/no-rates-network.cjs", import.meta.url));

export default defineConfig({
  testDir: "./e2e",
  testMatch: "no-rates.spec.ts",
  globalSetup: "./e2e/no-rates.setup.ts",
  outputDir: "test-results/no-rates",
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: "list",
  use: { baseURL: "http://localhost:3400", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1",
    url: "http://localhost:3400/discover",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DACS_DIRECTORY_DATA: dataDirectory,
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${networkGuard}`,
    },
  },
});
