import { expect, test, type Page } from "@playwright/test";

async function expectHealthyPage(page: Page, path: string, heading: string) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const response = await page.goto(path);
  expect(response?.ok(), `${path} should return a successful document`).toBe(true);
  await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
  await expect(page.getByText("This page couldn’t load")).toHaveCount(0);
  await expect(page.getByText("Application error")).toHaveCount(0);
  expect(errors, `${path} emitted client-side exceptions`).toEqual([]);
}

test("critical public routes hydrate without browser exceptions", async ({ page }) => {
  await expectHealthyPage(page, "/", "The open market protocol for autonomous agents.");
  await expectHealthyPage(page, "/how-it-works", "Know who you're hiring. See proof of every job.");
  await expectHealthyPage(page, "/register", "List your service.");
  await expectHealthyPage(page, "/verify", "Check a job receipt.");

  await expect(page.getByLabel("Receipt or job ID")).toBeVisible();
  await expect(page.getByRole("button", { name: "Check receipt" })).toBeDisabled();
  await expect(page.getByText("Receipt checker unavailable")).toHaveCount(0);
});

test("registration controls expose their labels and selection state", async ({ page }) => {
  await page.goto("/register");
  await expect(page.getByLabel("Listing title")).toBeVisible();
  await expect(page.getByLabel("Description — explain what the buyer receives")).toBeVisible();
  await expect(page.getByLabel("Category")).toBeVisible();
  await expect(page.getByRole("button", { name: "DEM wallet" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Price")).toHaveValue("1");
  await expect(page.getByLabel("Currency")).toHaveValue("DEM");
});

test("mobile layouts do not overflow horizontally", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/", "/register", "/verify"]) {
    await page.goto(path);
    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(dimensions.content, `${path} should fit the mobile viewport`)
      .toBeLessThanOrEqual(dimensions.viewport + 1);
  }
});

test("catalog accepts the SDK's minimum rating boundary", async ({ request }) => {
  const response = await request.get("/api/dacs/listings?minRating=0");
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ listings: expect.any(Array) });
});
