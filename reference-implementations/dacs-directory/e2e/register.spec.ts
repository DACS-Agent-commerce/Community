import { expect, test } from "@playwright/test";
test("this release exposes discovery submission, with no wallet publication flow", async ({ page }) => {
  const writes: string[] = [];
  await page.route("**/api/dacs/**", async route => {
    if (route.request().method() === "POST") writes.push(route.request().url());
    await route.fulfill({ json: {} });
  });
  await page.goto("/register");
  await expect(page.getByRole("heading", { name: "Submit listing pointers" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Read the registration API" })).toHaveAttribute("href", "#registration-api");
  await expect(page.getByRole("button", { name: /connect|sign|publish|resume/i })).toHaveCount(0);
  await page.getByRole("link", { name: "Read the registration API" }).click();
  await expect(page.getByRole("heading", { name: "Registration API", exact: true })).toBeVisible();
  await expect(page.getByText("unsigned updates return 403", { exact: false })).toBeVisible();
  expect(writes).toEqual([]);
});

