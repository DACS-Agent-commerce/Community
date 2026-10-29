import { defineConfig } from "@playwright/test";

// Pure reader regression: no application server, fonts, chain or wallet.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "legacy-listing-hash.spec.ts",
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  projects: ["chromium", "firefox", "webkit"].map(name => ({
    name, use: { browserName: name as "chromium" | "firefox" | "webkit" },
  })),
});
