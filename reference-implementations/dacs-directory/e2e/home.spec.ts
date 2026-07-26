import { expect, test } from "@playwright/test";

test("the landing page leads to discovery and exposes playback controls", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "This is a real deal between two agents." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Browse the directory" })).toHaveAttribute("href", "/discover");

  const playback = page.getByRole("button", { name: "Pause" });
  await expect(playback).toBeVisible();
  await playback.click();
  await expect(page.getByRole("button", { name: "Play" })).toHaveAttribute("aria-pressed", "true");

  await page.goto("/discover");
  await expect(page.getByRole("heading", { name: "Find agents you can verify." })).toBeVisible();
});

test("the proposal URL redirects to the landing page", async ({ page }) => {
  await page.goto("/home-proposal");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "This is a real deal between two agents." })).toBeVisible();
});

test("the primary navigation collapses before it can overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/");

  const menu = page.getByRole("button", { name: "Open menu" });
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(page.getByRole("link", { name: "discover", exact: true })).toBeVisible();
});

test("the mobile hero keeps its visual and keyboard order aligned", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const heroBlocks = page.locator(".hp-hero-copy, .hp-demo, .hp-hero-actions");
  await expect(heroBlocks).toHaveCount(3);
  const blockTops = await heroBlocks.evaluateAll((blocks) =>
    blocks.map((block) => Math.round(block.getBoundingClientRect().top)),
  );
  assertNondecreasing(blockTops);

  const emptyState = page.locator(".hp-stats-empty");
  await expect(emptyState).toHaveText("indexing the chain…");
  const emptyStateFontSize = await emptyState.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  expect(emptyStateFontSize).toBeLessThan(13);

  const focusableLabels = await page.locator(".hp-hero a, .hp-hero button").evaluateAll((elements) =>
    elements.map((element) => element.textContent?.trim()),
  );
  expect(focusableLabels).toEqual([
    "Pause",
    "try dacs →",
    "Browse the directory",
    "Run a deal yourself →",
  ]);

  const focusableTops = await page.locator(".hp-hero a, .hp-hero button").evaluateAll((elements) =>
    elements.map((element) => Math.round(element.getBoundingClientRect().top)),
  );
  assertNondecreasing(focusableTops);
});

function assertNondecreasing(values: number[]) {
  for (let index = 1; index < values.length; index += 1) {
    expect(values[index]).toBeGreaterThanOrEqual(values[index - 1]!);
  }
}
