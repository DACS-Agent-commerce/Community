import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { projectTestnetCatalog } from "../src/catalog/testnetMetrics.js";
import { noRateCatalog } from "./fixtures/no-rate-catalog.js";
import { GET as getLlms } from "../app/llms.txt/route.js";

test("listings sharing a category and window derive its observation count once", () => {
  const fixture = noRateCatalog();
  const seller = fixture.sellers[0];
  const listing = seller.listings[0];
  seller.listings = Array.from({ length: 32 }, (_, index) => ({ ...listing, listingId: `listing-${index}` }));
  let eligibilityReads = 0;
  for (const deal of seller.deals) {
    Object.defineProperty(deal, "reputationEligible", { enumerable: true, get() { eligibilityReads++; return true; } });
  }
  const projected = projectTestnetCatalog(fixture);
  assert.deepEqual(projected.sellers[0].listings.map((item) => item.reputationHint?.bundleCount), Array(32).fill(6));
  // One seller derivation, one shared hint derivation and the evidence copy.
  assert.ok(eligibilityReads <= seller.deals.length * 3, `eligibility read ${eligibilityReads} times`);
});

test("hint counts remain independent for different categories and windows", () => {
  const fixture = noRateCatalog();
  const seller = fixture.sellers[0];
  const listing = seller.listings[0];
  const hint = listing.reputationHint;
  assert.ok(hint);
  seller.listings.push({ ...listing, listingId: "later", reputationHint: { ...hint, windowStart: 103 } },
    { ...listing, listingId: "other", offering: { ...listing.offering, category: "other" }, reputationHint: undefined });
  const projected = projectTestnetCatalog(fixture);
  assert.deepEqual(projected.sellers[0].listings.map((item) => item.reputationHint?.bundleCount), [6, 3, 0]);
});

test("live agent guidance advertises supported filters and explicitly refuses rates", async () => {
  const text = await (await getLlms()).text();
  assert.doesNotMatch(text, /supports[^.]*minCompletionRate|supports[^.]*minRating/);
  assert.match(text, /minCompletionRate.*minRating.*trackRecord/);
  assert.match(text, /return 400/);
});

test("hint validation describes the local Directory contract without inventing an SDK reader", () => {
  for (const file of ["../src/catalog/testnetMetrics.ts", "../src/catalog/contracts.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /pinned SDK (?:catalog )?reader/);
  }
});
