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
