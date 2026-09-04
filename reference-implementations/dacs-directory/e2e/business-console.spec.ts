import { expect, test } from "@playwright/test";

test("provider can enter and explore the sample business console", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const response = await page.goto("/business");
  expect(response?.ok()).toBe(true);
  await expect(page.getByRole("heading", { name: "Your agent business, in one place." })).toBeVisible();
  await expect(page.getByText("there is no transaction or fee", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Explore a sample business" }).click();
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  await expect(page.getByText("Figures are representative, not indexed claims.")).toBeVisible();
  await expect(page.getByText("184.0 DEM").first()).toBeVisible();

  await page.getByRole("button", { name: "Revenue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Revenue without false conversions" })).toBeVisible();
  await expect(page.getByText("DEM and USDC are never added together.", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Agent access", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your storefront has a machine-readable entrance." })).toBeVisible();
  expect(errors).toEqual([]);
});

test("Demos wallet entry connects and signs without requesting a transaction", async ({ page }) => {
  await page.addInitScript(() => {
    const calls: Array<{ method: string; params?: unknown[] }> = [];
    const address = `0x${"4".repeat(64)}`;
    window.__demosProviderCaptured = {
      request: async (request) => {
        calls.push(request);
        if (request.method === "connect") return { success: true, data: { address } };
        if (request.method === "sign") return { success: true, data: { signature: `0x${"a".repeat(128)}` } };
        throw new Error(`Unexpected wallet method: ${request.method}`);
      },
    };
    Object.assign(window, { __businessWalletCalls: calls });
  });

  await page.goto("/business");
  await page.getByRole("button", { name: "Continue with Demos" }).click();
  await expect(page.getByRole("heading", { name: "No provider business is indexed for this wallet yet." })).toBeVisible();

  const calls = await page.evaluate(() => (window as typeof window & {
    __businessWalletCalls: Array<{ method: string; params?: Array<{ publicKey?: string }> }>;
  }).__businessWalletCalls);
  expect(calls.map((call) => call.method)).toEqual(["connect", "sign"]);
  expect(calls[1].params?.[0]?.publicKey).toBe(`0x${"4".repeat(64)}`);
});

test("business entry and console fit a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/business");
  let dimensions = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);

  await page.getByRole("button", { name: "Explore a sample business" }).click();
  dimensions = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
  await expect(page.getByLabel("Business console section")).toBeVisible();
});
