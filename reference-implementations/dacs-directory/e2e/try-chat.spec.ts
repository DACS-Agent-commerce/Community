import { expect, test } from "@playwright/test";

test("the recorded deal is inspectable and cannot dispatch a purchase", async ({ page }) => {
  let procurementRequests = 0;
  await page.route("**/demo/procurement**", async (route) => {
    procurementRequests += 1;
    await route.abort("blockedbyclient");
  });

  await page.goto("/try-chat");
  await expect(page.getByLabel("Recorded replay disclosure")).toContainText("never starts a job or spends funds");
  await expect(page.getByRole("link", { name: /Run a live deal/ })).toHaveAttribute("href", "/try");

  await page.getByRole("button", { name: /Watch the recorded deal/ }).click();
  await page.getByRole("button", { name: "Show the full deal now" }).click();

  await expect(page.locator(".tc-outcome-badge")).toContainText("Recorded deal settled & verified");
  await expect(page.locator(".tc-stage-done")).toHaveCount(5);
  const payment = page.getByRole("link", { name: /verify tx 53dd8a7b…e0ff24/ });
  await expect(payment).toHaveAttribute("href", "https://explorer.demos.sh/tx/53dd8a7b34f7d29377c27599e17a5742b2c7296dd048b1235c04359957e0ff24");
  expect(procurementRequests).toBe(0);
});
