import { expect, test } from "@playwright/test";
import { LISTING_PUBLICATION_KEY } from "../src/components/listing-publication-recovery.js";
const claim = `did:demos:agent:${"12".repeat(32)}`;
const anchorAddress = `stor-${"34".repeat(20)}`;
const pending = {
  version: 1, claim, listingId: "saved-service", listingVersion: 1, anchorAddress,
  programName: "saved-program", contentHash: "56".repeat(32), signedListing: {}, transaction: null,
  registration: { primaryClaim: claim, listingAnchors: [anchorAddress] },
  stage: "broadcast-uncertain", createdAt: 1786360000000,
};

test("this release exposes discovery submission, with no wallet publication flow", async ({ page }) => {
  const writes: string[] = [];
  await page.route("**/api/dacs/**", async route => {
    if (route.request().method() === "POST") writes.push(route.request().url());
    await route.fulfill({ json: {} });
  });
  await page.goto("/register");
  await expect(page.getByRole("heading", { name: "Submit listing pointers" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Read the registration API" })).toHaveAttribute("href", "/api/dacs");
  await expect(page.getByRole("button", { name: /connect|sign|publish|resume/i })).toHaveCount(0);
  expect(writes).toEqual([]);
});

for (const value of [null, { listingId: "saved-service" }]) test(`saved publication can be checked and deliberately discarded (${value ? "visible" : "unreadable"})`, async ({ page }) => {
  await page.addInitScript(({ key, pending }) => { localStorage.setItem(key, JSON.stringify(pending)); }, { key: LISTING_PUBLICATION_KEY, pending });
  const requests: string[] = [];
  await page.route("**/api/dacs/**", async route => {
    requests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    await route.fulfill({ json: { value } });
  });
  await page.goto("/register");
  await expect(page.getByRole("heading", { name: "Saved publication recovery" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Discard local recovery data" })).toHaveCount(0);
  await page.getByRole("button", { name: "Check saved anchor" }).click();
  await expect(page.getByRole("status")).toContainText(value ? "reports data" : "no readable data");
  await expect(page.getByRole("button", { name: "Discard local recovery data" })).toBeDisabled();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Discard local recovery data" }).click();
  await expect(page.getByRole("heading", { name: "Saved publication recovery" })).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), LISTING_PUBLICATION_KEY)).toBeNull();
  expect(requests).toEqual(["GET /api/dacs/artifact"]);
});

test("an unavailable anchor check retains recovery data", async ({ page }) => {
  await page.addInitScript(({ key, pending }) => { localStorage.setItem(key, JSON.stringify(pending)); }, { key: LISTING_PUBLICATION_KEY, pending });
  await page.route("**/api/dacs/artifact?*", route => route.fulfill({ status: 503, json: {} }));
  await page.goto("/register");
  await page.getByRole("button", { name: "Check saved anchor" }).click();
  await expect(page.getByRole("status")).toContainText("could not be checked");
  await expect(page.getByRole("button", { name: "Discard local recovery data" })).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), LISTING_PUBLICATION_KEY)).not.toBeNull();
});
