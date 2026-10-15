import { expect, test, type Page } from "@playwright/test";
import { noRateClaim } from "../test/fixtures/no-rate-catalog.js";

const claim = encodeURIComponent(noRateClaim);

async function expectNoRates(page: Page) {
  await expect(page.getByText("Completion verification unavailable", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Observed outcomes: 6, not verified/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /completion|rating|score/i })).toHaveCount(0);
  const visible = await page.locator("body").innerText();
  expect(visible).not.toMatch(/\d+(?:\.\d+)?\s*%|\d+\s*strict-verified\s*\/|\b1\s*\/\s*6\b|\d+(?:\.\d+)?\s*(?:stars|rating|score)/i);
  // Include the server-to-client catalog payload as well as visible content.
  expect(await page.content()).not.toMatch(/(?:completionRate|counterpartyAdjustedCompletionRate|counterpartyFaultRate|averageSellerRating|averageBuyerRating|value)\\?"\s*:\s*\d/);
}

test.beforeEach(async ({ page }) => {
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).hostname === "localhost") await route.continue();
    else await route.abort();
  });
});

test("discovery and service detail keep labelled observations and evidence without rate badges", async ({ page }) => {
  await page.goto("/discover");
  await expectNoRates(page);
  await expect(page.getByRole("link", { name: "Observed history inspection" })).toBeVisible();
  await page.getByRole("link", { name: "Explore service", exact: true }).click();
  await expectNoRates(page);
  await expect(page.getByRole("link", { name: "View signed listing artifact" })).toHaveAttribute("href", /\/api\/dacs\/listings\/observed-history\/1/);
  await expect(page.getByRole("link", { name: "Inspect service", exact: true })).toBeVisible();
  const inspection = await page.request.get(`/api/dacs/inspect-service/observed-history/1?seller=${claim}`);
  expect(inspection.ok()).toBe(true);
  expect((await inspection.json()).artifact.listing.anchor.locator).toBe(`stor-${"9".repeat(40)}`);
});

test("seller evidence includes aborted outcomes and individual inspection links without a completion ratio", async ({ page }) => {
  await page.goto(`/seller/${claim}`);
  await expectNoRates(page);
  await expect(page.getByRole("cell", { name: "aborted-by-self", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "aborted-by-other", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "verify yourself →" })).toHaveCount(6);
  const response = await page.request.get(`/api/dacs/sellers/${claim}`);
  expect(response.ok()).toBe(true);
  const seller = await response.json();
  for (const key of ["completionRate", "counterpartyAdjustedCompletionRate", "counterpartyFaultRate", "averageBuyerRating", "averageSellerRating"]) {
    expect(seller.reputation[key]).toBeNull();
    expect(seller.listings[0].reputationHint[key]).toBeNull();
  }
  expect(seller.deals[0].ratings[0].value).toBeNull();
  expect(seller.reputation.observedOutcomesLabel).toBe("Observed outcomes: 6, not verified");
});

test("old filter URLs show a refusal and can be cleared; API rate and score queries return 400", async ({ page }) => {
  for (const query of ["trackRecord=90", "minCompletionRate=0.9", "minRating=5", "sort=completionRate"]) {
    await page.goto(`/discover?${query}`);
    await expect(page.getByRole("alert")).toContainText("unavailable on testnet");
    const response = await page.request.get(`/api/dacs/listings?${query}`);
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toContain("unavailable on testnet");
    await page.getByRole("button", { name: "Clear all filters", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expectNoRates(page);
  }
});
