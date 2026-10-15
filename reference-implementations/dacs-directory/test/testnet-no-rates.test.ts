import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { noRateCatalog, noRateClaim, noRateOutcomes } from "./fixtures/no-rate-catalog.js";
import { deriveSellerReputation } from "../src/catalog/reputation.js";
import { COMPLETION_VERIFICATION_UNAVAILABLE, UNAVAILABLE_TESTNET_METRICS } from "../src/catalog/testnetMetrics.js";

const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-testnet-no-rates-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
const { loadCatalog, saveCatalog } = await import("../src/catalog/store.js");
const { GET: getListings } = await import("../app/api/dacs/listings/route.js");
const { GET: getSeller } = await import("../app/api/dacs/sellers/[primaryClaimRef]/route.js");
const { GET: inspectService } = await import("../app/api/dacs/inspect-service/[listingId]/[version]/route.js");
const { GET: getLlms } = await import("../app/llms.txt/route.js");
test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));

function assertUnavailable(metrics: Record<string, unknown>) {
  for (const [key, value] of Object.entries(UNAVAILABLE_TESTNET_METRICS)) {
    assert.equal(metrics[key], value, key);
  }
  assert.equal(metrics.observedOutcomesLabel, "Observed outcomes: 6, not verified");
}

function assertNoNumericMetrics(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, member] of Object.entries(value)) {
    if (/(?:rate|rating|score)$/i.test(key)) assert.notEqual(typeof member, "number", key);
    if (key === "value") assert.equal(member, null, "catalog rating value must be unavailable");
    assertNoNumericMetrics(member);
  }
}

test("populated history including both abort outcomes derives counts and evidence without rates or scores", () => {
  const reputation = deriveSellerReputation(noRateCatalog().sellers[0].deals, 0, 200);
  assertUnavailable(reputation);
  assert.equal(reputation.completed, 1);
  assert.match(reputation.completedLabel!, /Observed completed outcomes, not verified/);
  assert.match(reputation.observedTransactionalVolumeLabel!, /not verified completion or settlement/);
  assert.match(reputation.transactionCountByCurrencyLabel!, /not verified completion or settlement/);
  assert.equal(reputation.totalAgreements, 6);
  assert.equal(reputation.bundleRefs?.length, 6);
  assertNoNumericMetrics(reputation);
});

test("cached catalog, listings API and seller API hide old metrics and retain labelled counts and evidence", async () => {
  const fixture = noRateCatalog();
  Object.assign(fixture.sellers[0].reputation, { reputationScore: 7, futureScore: 8, opaque: { numericScore: 9 } });
  Object.assign(fixture.sellers[0].listings[0].reputationHint!, { reputationScore: 7, futureScore: 8 });
  Object.assign(fixture.sellers[0].deals[0].ratings![0], { numericScore: 9 });
  saveCatalog(fixture);
  // Repeat reads without reindexing; the cached numeric inputs must stay hidden.
  for (let read = 0; read < 2; read++) {
    const catalog = loadCatalog();
    assertUnavailable(catalog.sellers[0].reputation);
    assertUnavailable({ ...catalog.sellers[0].listings[0].reputationHint });
    assertNoNumericMetrics(catalog);
    const listings = await getListings(new NextRequest("https://directory.example/api/dacs/listings"));
    assert.equal(listings.status, 200);
    const page = await listings.json();
    assert.equal(page.total, 1);
    assertUnavailable(page.listings[0].reputationHint);
    assert.ok(page.listings[0].inspection.href);
    assertNoNumericMetrics(page);
    const response = await getSeller(new NextRequest("https://directory.example/api/dacs/sellers/test"), {
      params: Promise.resolve({ primaryClaimRef: encodeURIComponent(noRateClaim) }),
    });
    assert.equal(response.status, 200);
    const seller = await response.json();
    assertUnavailable(seller.reputation);
    assert.equal(seller.reputation.profile, "TP-1");
    assert.equal(seller.reputation.opaque, undefined);
    assert.match(seller.reputation.completedLabel, /not verified/);
    assertUnavailable(seller.listings[0].reputationHint);
    assert.match(seller.reputation.limitation, /Completion verification unavailable/);
    assert.deepEqual(seller.deals.map((deal: { outcome: string }) => deal.outcome), noRateOutcomes);
    assert.equal(seller.reputation.bundleRefs.length, 6);
    assert.equal(seller.deals[0].buyerBundleRef, fixture.sellers[0].deals[0].buyerBundleRef);
    assert.equal(seller.deals[0].ratings[0].value, null);
    assert.equal(seller.deals[0].ratings[0].metricsUnavailableReason, COMPLETION_VERIFICATION_UNAVAILABLE);
    assertNoNumericMetrics(seller);
    const inspection = await inspectService(new NextRequest(`https://directory.example/api/dacs/inspect-service/observed-history/1?seller=${encodeURIComponent(noRateClaim)}`), {
      params: Promise.resolve({ listingId: "observed-history", version: "1" }),
    });
    assert.equal(inspection.status, 200);
    const evidence = await inspection.json();
    assert.equal(evidence.artifact.listing.anchor.locator, fixture.sellers[0].listings[0].anchor.locator);
    assert.ok(evidence.artifact.links.listingJson);
  }
  assert.equal(fixture.sellers[0].reputation.completionRate, 0.95, "input fixture is not mutated");
  assert.equal((fixture.sellers[0].reputation as unknown as Record<string, unknown>).reputationScore, 7);
});

test("cached listings without a scoped hint publish null metrics and explicitly unavailable counts through both APIs", async () => {
  const fixture = noRateCatalog();
  delete fixture.sellers[0].listings[0].reputationHint;
  saveCatalog(fixture);
  const listings = await getListings(new NextRequest("https://directory.example/api/dacs/listings"));
  const seller = await getSeller(new NextRequest("https://directory.example/api/dacs/sellers/test"), {
    params: Promise.resolve({ primaryClaimRef: encodeURIComponent(noRateClaim) }),
  });
  assert.equal(listings.status, 200);
  assert.equal(seller.status, 200);
  for (const body of [await listings.json(), await seller.json()]) {
    const hint = body.listings[0].reputationHint;
    for (const [key, value] of Object.entries(UNAVAILABLE_TESTNET_METRICS)) assert.equal(hint[key], value, key);
    assert.equal(hint.bundleCount, undefined, "missing scoped history is not a zero count");
    assert.equal(hint.observedOutcomesLabel, "Observed outcomes unavailable, not verified");
    assertNoNumericMetrics(body);
  }
  assert.equal(fixture.sellers[0].listings[0].reputationHint, undefined, "input is untouched");
});

test("rate and score filters and ordering return a clear 400 even with empty, repeated or malformed values", async () => {
  for (const query of [
    "minCompletionRate=0.9", "minCompletionRate=0", "minCompletionRate=", "minCompletionRate=bad",
    "minCompletionRate=0.9&minCompletionRate=0.1", "minRating=5", "minRating=", "minRating=bad",
    "trackRecord=90", "maxFaultRate=0.1", "reputationScore=3", "sort=completionRate",
    "sortBy=averageSellerRating", "orderBy=counterpartyFaultRate", "rankBy=reputationScore",
    "MINCOMPLETIONRATE%5B%5D=0.9", "minRating%5B%5D%5B%5D=5", "trackRecord%5B%5D=90",
    "minCompletionRate%5B%5D=", "sort=price", "order=asc", "rank%5B%5D=price",
  ]) {
    const response = await getListings(new NextRequest(`https://directory.example/api/dacs/listings?${query}`));
    assert.equal(response.status, 400, query);
    const { error } = await response.json();
    assert.match(error, /unavailable on testnet/, query);
    assert.match(error, /TP-1/, query);
    assert.doesNotMatch(error, /minCompletionRate|MINCOMPLETIONRATE|sort=|order=|rank=/, query);
    if (/^(?:sort|order|rank)/i.test(query)) assert.equal(error, "Sorting and ranking are unavailable on testnet under TP-1.");
  }
});

test("llms discovery text states the TP-1 null-metric and refused-filter contract", async () => {
  const response = await getLlms();
  const text = await response.text();
  assert.match(text, /TP-1/);
  assert.match(text, /Completion verification unavailable/);
  assert.match(text, /minCompletionRate.*minRating.*trackRecord/);
  assert.match(text, /400/);
});

test("non-rate search and price filtering still work over the same history", async () => {
  saveCatalog(noRateCatalog());
  for (const [query, expected] of [
    ["category=services&rail=pay-dem&tag=history&q=inspection&priceMax=3", 1],
    ["priceMax=1", 0],
  ] as const) {
    const response = await getListings(new NextRequest(`https://directory.example/api/dacs/listings?${query}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total, expected);
    assertNoNumericMetrics(body);
  }
});
