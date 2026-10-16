import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { noRateCatalog, noRateClaim, noRateOutcomes } from "./fixtures/no-rate-catalog.js";
import { deriveSellerReputation } from "../src/catalog/reputation.js";
import { queryListingCatalog } from "../vendor/dacs-sdk/dist/discovery/catalog.js";
import { COMPLETION_VERIFICATION_UNAVAILABLE, UNAVAILABLE_TESTNET_METRICS } from "../src/catalog/testnetMetrics.js";
import { listingSummarySchema } from "../src/catalog/contracts.js";

const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-testnet-no-rates-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
const { loadCatalog, loadStoredCatalog, saveCatalog } = await import("../src/catalog/store.js");
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

test("an empty store serves the empty catalog", () => {
  assert.deepEqual(loadCatalog(), { catalogVersion: "1", generatedAt: 0, sellers: [] });
  assert.deepEqual(loadStoredCatalog(), { catalogVersion: "1", generatedAt: 0, sellers: [] });
});

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
  // Unknown cached metrics outside the allowlisted shapes, at every level.
  Object.assign(fixture.sellers[0], { trustScore: 4, completionRate: 0.9 });
  Object.assign(fixture.sellers[0].deals[0], { reputationScore: 3, faultRate: "0.1" });
  Object.assign(fixture.sellers[0].listings[0], { completionRate: 0.9, sellerRating: 5 });
  saveCatalog(fixture);
  const { bundleRefs, observedTransactionalVolume, transactionCountByCurrency } = fixture.sellers[0].reputation;
  // Repeat reads without reindexing; the cached numeric inputs must stay hidden.
  for (let read = 0; read < 2; read++) {
    const catalog = loadCatalog();
    assertUnavailable(catalog.sellers[0].reputation);
    assertUnavailable({ ...catalog.sellers[0].listings[0].reputationHint });
    assertNoNumericMetrics(catalog);
    assert.deepEqual(catalog.sellers[0].reputation.bundleRefs, bundleRefs);
    assert.deepEqual(catalog.sellers[0].reputation.observedTransactionalVolume, observedTransactionalVolume);
    assert.deepEqual(catalog.sellers[0].reputation.transactionCountByCurrency, transactionCountByCurrency);
    for (const record of [catalog.sellers[0], catalog.sellers[0].deals[0], catalog.sellers[0].listings[0]]) {
      assert.deepEqual(Object.keys(record).filter((key) => /(?:rate|rating|score)$/i.test(key)), []);
    }
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
    assert.deepEqual(seller.reputation.bundleRefs, bundleRefs);
    assert.deepEqual(seller.reputation.observedTransactionalVolume, observedTransactionalVolume);
    assert.deepEqual(seller.reputation.transactionCountByCurrency, transactionCountByCurrency);
    assert.equal(seller.deals[0].reputationScore, undefined);
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
  // Reads never write the projection back: the stored catalog keeps its indexed values.
  const stored = loadStoredCatalog();
  assert.equal(stored.sellers[0].deals[0].ratings![0].value, 5);
  assert.equal(stored.sellers[0].reputation.completionRate, 0.95);
  assert.equal(fixture.sellers[0].reputation.completionRate, 0.95, "input fixture is not mutated");
  assert.equal((fixture.sellers[0].reputation as unknown as Record<string, unknown>).reputationScore, 7);
});

test("cached listings without a hint publish null metrics and scoped observations accepted by the SDK through both APIs", async () => {
  const fixture = noRateCatalog();
  delete fixture.sellers[0].listings[0].reputationHint;
  fixture.sellers[0].deals.forEach((deal) => { deal.category = "services.test.child"; });
  fixture.sellers[0].deals[0].category = "services.other";
  fixture.sellers[0].deals[3].category = "services.test";
  fixture.sellers[0].deals[4].category = "services.testing";
  fixture.sellers[0].deals[1].refsVerified = false;
  fixture.sellers[0].deals[2].reputationEligible = false;
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
    assert.equal(hint.bundleCount, 2, "only retained eligible observations in the exact category or a child count");
    assert.equal(hint.observedOutcomesLabel, "Observed outcomes: 2, not verified");
    assert.equal(hint.windowStart, 0);
    assert.equal(hint.windowEnd, fixture.generatedAt);
    assert.equal(hint.computedAt, fixture.generatedAt);
    assertNoNumericMetrics(body);
    const result = await queryListingCatalog({
      catalogUrl: "https://directory.example/api/dacs/listings",
      fetchImpl: async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
    });
    assert.equal(result.status, "ok", JSON.stringify(result));
  }
  assert.equal(fixture.sellers[0].listings[0].reputationHint, undefined, "input is untouched");
});

async function listingPageHint(fixture: ReturnType<typeof noRateCatalog>) {
  saveCatalog(fixture);
  const response = await getListings(new NextRequest("https://directory.example/api/dacs/listings"));
  assert.equal(response.status, 200);
  const page = await response.json();
  const result = await queryListingCatalog({
    catalogUrl: "https://directory.example/api/dacs/listings",
    fetchImpl: async () => new Response(JSON.stringify(page), { headers: { "content-type": "application/json" } }),
  });
  return { page, hint: page.listings[0].reputationHint, sdkStatus: result.status };
}

test("cached hints the SDK reader would reject fall back to the synthesized hint", async () => {
  const malformed: Record<string, (hint: Record<string, unknown>) => void> = {
    "missing bundleCount": (hint) => { delete hint.bundleCount; },
    "non-prefix scope": (hint) => { hint.categoryScope = "services.tes"; },
    "empty scope": (hint) => { hint.categoryScope = ""; },
    "reversed window": (hint) => { hint.windowStart = 300; hint.windowEnd = 200; },
    "negative computedAt": (hint) => { hint.computedAt = -1; },
    "fractional windowEnd": (hint) => { hint.windowEnd = 200.5; },
  };
  for (const [name, corrupt] of Object.entries(malformed)) {
    const fixture = noRateCatalog();
    fixture.sellers[0].deals.forEach((deal) => { deal.category = "services.test"; });
    fixture.sellers[0].deals[0].reputationEligible = false;
    corrupt(fixture.sellers[0].listings[0].reputationHint as unknown as Record<string, unknown>);
    const { hint, sdkStatus } = await listingPageHint(fixture);
    assert.equal(sdkStatus, "ok", name);
    assert.deepEqual({ ...hint }, {
      categoryScope: "services.test", bundleCount: 5, windowStart: 0, windowEnd: 200, computedAt: 200,
      ...UNAVAILABLE_TESTNET_METRICS, observedOutcomesLabel: "Observed outcomes: 5, not verified",
    }, name);
  }
  // A well-formed parent-scope cached hint is still served as cached.
  const fixture = noRateCatalog();
  Object.assign(fixture.sellers[0].listings[0].reputationHint!, { categoryScope: "services", windowStart: 10, computedAt: 150 });
  const { hint, sdkStatus } = await listingPageHint(fixture);
  assert.equal(sdkStatus, "ok");
  assert.deepEqual([hint.categoryScope, hint.bundleCount, hint.windowStart, hint.windowEnd, hint.computedAt], ["services", 6, 10, 200, 150]);
});

test("a cached scope that is a prefix but not a canonical string falls back to the listing category", async () => {
  const fixture = noRateCatalog();
  fixture.sellers[0].listings[0].offering.category = "services .test";
  fixture.sellers[0].deals.forEach((deal) => { deal.category = "services .test"; });
  fixture.sellers[0].listings[0].reputationHint!.categoryScope = "services ";
  const { hint, sdkStatus } = await listingPageHint(fixture);
  assert.equal(sdkStatus, "ok");
  assert.deepEqual([hint.categoryScope, hint.bundleCount, hint.windowStart, hint.windowEnd], ["services .test", 6, 0, 200]);
  const pattern = new RegExp(listingSummarySchema.properties.reputationHint.properties.categoryScope.pattern, "u");
  for (const scope of ["services ", " services", "services\t.test", "a\u0007b", "a\u007fb", ""]) assert.doesNotMatch(scope, pattern, JSON.stringify(scope));
  for (const scope of ["services .test", "services.test", "s"]) assert.match(scope, pattern, scope);
});

test("a served hint never counts SB-2 collision records its cached count still includes", async () => {
  const fixture = noRateCatalog();
  const shared = [{ id: `demos:${"ab".repeat(32)}`, observedAt: 100, phaseIndex: 2 }];
  fixture.sellers[0].deals[0].settlementTxIds = shared;
  fixture.sellers[0].deals[1].settlementTxIds = shared;
  assert.equal(fixture.sellers[0].listings[0].reputationHint!.bundleCount, 6, "cached before the collision was excluded");
  const { hint, sdkStatus } = await listingPageHint(fixture);
  assert.equal(sdkStatus, "ok");
  assert.equal(deriveSellerReputation(fixture.sellers[0].deals, 0, 200).bundleCount, 4);
  assert.equal(hint.bundleCount, 4);
  assert.equal(hint.observedOutcomesLabel, "Observed outcomes: 4, not verified");
});

test("the published hint schema matches emitted hints and requires every field the pinned SDK reader requires", async () => {
  const schema = listingSummarySchema.properties.reputationHint;
  const properties = schema.properties as Record<string, { type?: string; const?: unknown; minimum?: number; maximum?: number; minLength?: number; pattern?: string }>;
  const { page, hint, sdkStatus } = await listingPageHint(noRateCatalog());
  assert.equal(sdkStatus, "ok");
  assert.deepEqual(Object.keys(hint).filter((key) => !(key in properties)), [], "additionalProperties: false");
  for (const key of schema.required) assert.ok(key in hint, `emitted hint lacks required ${key}`);
  for (const [key, rule] of Object.entries(properties)) {
    const value = hint[key];
    if ("const" in rule) assert.equal(value, rule.const, key);
    else if (rule.type === "null") assert.equal(value, null, key);
    else if (rule.type === "string") {
      assert.ok(typeof value === "string" && value.length >= (rule.minLength ?? 0), key);
      if (rule.pattern) assert.match(value, new RegExp(rule.pattern, "u"), key);
    }
    else if (rule.type === "integer") {
      assert.ok(Number.isSafeInteger(value), key);
      assert.equal(rule.minimum, 0, key);
      assert.equal(rule.maximum, Number.MAX_SAFE_INTEGER, key);
    }
  }
  for (const key of Object.keys(hint)) {
    const { [key]: _omitted, ...without } = hint;
    const body = { ...page, listings: [{ ...page.listings[0], reputationHint: without }] };
    const result = await queryListingCatalog({
      catalogUrl: "https://directory.example/api/dacs/listings",
      fetchImpl: async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
    });
    if (result.status !== "ok") assert.ok((schema.required as readonly string[]).includes(key), `SDK rejects a hint without ${key}, so the schema must require it`);
  }
  for (const key of ["categoryScope", "bundleCount", "windowStart", "windowEnd", "computedAt"]) {
    assert.ok((schema.required as readonly string[]).includes(key), key);
  }
});

test("catalog writers read the stored catalog, never the public projection", () => {
  for (const file of ["../app/api/dacs/index-now/route.ts", "../src/catalog/reindexCore.ts", "../scripts/seed-counterparty-fixture.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /loadStoredCatalog\(\)/, file);
    assert.doesNotMatch(source, /\bloadCatalog\(/, file);
  }
});

test("rate and score filters and ordering return a clear 400 even with empty, repeated or malformed values", async () => {
  for (const query of [
    "minCompletionRate=0.9", "minCompletionRate=0", "minCompletionRate=", "minCompletionRate=bad",
    "minCompletionRate=0.9&minCompletionRate=0.1", "minRating=5", "minRating=", "minRating=bad",
    "trackRecord=90", "maxFaultRate=0.1", "reputationScore=3", "sort=completionRate",
    "sortBy=averageSellerRating", "orderBy=counterpartyFaultRate", "rankBy=reputationScore",
    "MINCOMPLETIONRATE%5B%5D=0.9", "minRating%5B%5D%5B%5D=5", "trackRecord%5B%5D=90",
    "minCompletionRate%5B%5D=", "sort=price", "order=asc", "rank%5B%5D=price",
    "faultRate=0.1", "completionRate=1", "counterpartyAdjustedCompletionRate=1", "counterpartyFaultRate=0",
    "averageBuyerRating=5", "averageSellerRating=5",
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
