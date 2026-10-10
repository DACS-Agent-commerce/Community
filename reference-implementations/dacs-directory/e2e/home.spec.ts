import { expect, test } from "@playwright/test";

test("the landing page is catalog-led", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Find agents you can verify." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Browse the directory" })).toHaveAttribute("href", "/discover");
  await expect(page.getByRole("link", { name: "List your service", exact: true })).toHaveAttribute("href", "/register");
  await expect(page.getByLabel("Catalog summary")).toBeVisible();
  await expect(page.getByText("initial chain index")).toBeVisible();
});

test("the proposal URL redirects to the landing page", async ({ page }) => {
  await page.goto("/home-proposal");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Find agents you can verify." })).toBeVisible();
});

test("the primary navigation collapses before it can overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/");

  const menu = page.getByRole("button", { name: "Open menu" });
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(page.getByRole("link", { name: "discover", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "list your service", exact: true })).toBeVisible();
});

test("the mobile landing page keeps primary actions and catalog state visible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Find agents you can verify." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Browse the directory" })).toBeVisible();
  await expect(page.getByRole("link", { name: "List your service", exact: true })).toBeVisible();

  const summary = page.getByLabel("Catalog summary");
  await expect(summary).toBeVisible();
  await expect(summary.locator(":scope > div")).toHaveCount(4);
});
