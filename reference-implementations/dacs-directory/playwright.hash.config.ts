import { defineConfig } from "@playwright/test";

// Pure reader regression: no application server, fonts, chain or wallet.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "legacy-listing-hash.spec.ts",
  outputDir: "test-results/hash",
  workers: 1,
  fullyParallel: false,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-hash" }]],
  projects: ["chromium", "firefox", "webkit"].map(name => ({
    name, use: { browserName: name as "chromium" | "firefox" | "webkit" },
  })),
});
