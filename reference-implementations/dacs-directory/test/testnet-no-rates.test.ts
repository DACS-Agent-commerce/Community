import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { noRateCatalog, noRateClaim, noRateOutcomes } from "./fixtures/no-rate-catalog.js";
import type { Catalog } from "../src/catalog/types.js";
import { deriveSellerReputation } from "../src/catalog/reputation.js";
import { COMPLETION_VERIFICATION_UNAVAILABLE, LISTING_QUERY_PARAMETERS, UNAVAILABLE_TESTNET_METRICS } from "../src/catalog/testnetMetrics.js";
import { directoryManifest, listingSummarySchema, openApiDocument } from "../src/catalog/contracts.js";

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
  Object.assign(fixture.sellers[0], { trustScore: 4, completionRate: 0.9, corporateName: "Seller Corporation" });
  Object.assign(fixture.sellers[0].deals[0], { reputationScore: 3, faultRate: "0.1", corporateName: "Deal Corporation" });
  Object.assign(fixture.sellers[0].listings[0], { completionRate: 0.9, sellerRating: 5, corporateName: "Listing Corporation" });
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
    assert.equal((catalog.sellers[0] as unknown as Record<string, unknown>).corporateName, "Seller Corporation");
    assert.equal((catalog.sellers[0].deals[0] as unknown as Record<string, unknown>).corporateName, "Deal Corporation");
    assert.equal((catalog.sellers[0].listings[0] as unknown as Record<string, unknown>).corporateName, "Listing Corporation");
    const listings = await getListings(new NextRequest("https://directory.example/api/dacs/listings"));
    assert.equal(listings.status, 200);
    const page = await listings.json();
    assert.equal(page.total, 1);
    assertUnavailable(page.listings[0].reputationHint);
    assert.ok(page.listings[0].inspection.href);
    assert.equal(page.listings[0].corporateName, "Listing Corporation");
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
    assert.equal(seller.deals[0].corporateName, "Deal Corporation");
    assert.equal(seller.listings[0].corporateName, "Listing Corporation");
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
  assert.equal((stored.sellers[0] as unknown as Record<string, unknown>).corporateName, "Seller Corporation");
  assert.equal((stored.sellers[0].deals[0] as unknown as Record<string, unknown>).corporateName, "Deal Corporation");
  assert.equal((stored.sellers[0].listings[0] as unknown as Record<string, unknown>).corporateName, "Listing Corporation");
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
  }
  assert.equal(fixture.sellers[0].listings[0].reputationHint, undefined, "input is untouched");
});

async function listingPageHint(fixture: ReturnType<typeof noRateCatalog>) {
  saveCatalog(fixture);
  const response = await getListings(new NextRequest("https://directory.example/api/dacs/listings"));
  assert.equal(response.status, 200);
  const page = await response.json();
  return { page, hint: page.listings[0].reputationHint };
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
    const { hint } = await listingPageHint(fixture);
    assert.deepEqual({ ...hint }, {
      categoryScope: "services.test", bundleCount: 5, windowStart: 0, windowEnd: 200, computedAt: 200,
      ...UNAVAILABLE_TESTNET_METRICS,
      observedOutcomesLabel: "Observed outcomes: 5, not verified",
    }, name);
  }
  // A well-formed parent-scope cached hint is still served as cached.
  const fixture = noRateCatalog();
  Object.assign(fixture.sellers[0].listings[0].reputationHint!, { categoryScope: "services", windowStart: 10, computedAt: 150 });
  const { hint } = await listingPageHint(fixture);
  assert.deepEqual([hint.categoryScope, hint.bundleCount, hint.windowStart, hint.windowEnd, hint.computedAt], ["services", 6, 10, 200, 150]);
});

test("a cached scope that is a prefix but not a canonical string falls back to the listing category", async () => {
  const fixture = noRateCatalog();
  fixture.sellers[0].listings[0].offering.category = "services .test";
  fixture.sellers[0].deals.forEach((deal) => { deal.category = "services .test"; });
  fixture.sellers[0].listings[0].reputationHint!.categoryScope = "services ";
  const { hint } = await listingPageHint(fixture);
  assert.deepEqual([hint.categoryScope, hint.bundleCount, hint.windowStart, hint.windowEnd], ["services .test", 6, 0, 200]);
  const pattern = new RegExp(listingSummarySchema.properties.reputationHint.properties.categoryScope.pattern, "u");
  for (const scope of ["services ", " services", "services\t.test", "a\u0007b", "a\u007fb", ""]) assert.doesNotMatch(scope, pattern, JSON.stringify(scope));
  for (const scope of ["services .test", "services.test", "s"]) assert.match(scope, pattern, scope);
});
test("the published hint schema matches emitted hints and requires every field the pinned SDK reader requires", async () => {
  const schema = listingSummarySchema.properties.reputationHint;
  const properties = schema.properties as Record<string, { type?: string; const?: unknown; minimum?: number; maximum?: number; minLength?: number; pattern?: string }>;
  const { page, hint } = await listingPageHint(noRateCatalog());
  assert.deepEqual(Object.keys(hint).filter((key) => !(key in properties)), [], "additionalProperties: false");
  for (const key of schema.required) assert.ok(key in hint, `emitted hint lacks required ${key}`);
  // TP-1: all five metrics are present and null on every surface, so the schema requires each one.
  for (const key of ["completionRate", "counterpartyAdjustedCompletionRate", "counterpartyFaultRate", "averageBuyerRating", "averageSellerRating"]) {
    assert.ok((schema.required as readonly string[]).includes(key), `schema requires ${key}`);
    assert.equal(properties[key].type, "null", key);
  }
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
  for (const key of ["categoryScope", "bundleCount", "windowStart", "windowEnd", "computedAt"]) {
    assert.ok((schema.required as readonly string[]).includes(key), key);
  }
  // The scope pattern spells out its whitespace instead of `\s`, so non-ECMA
  // validators agree, and it still means exactly what the ECMA `\s` form meant.
  const pattern = properties.categoryScope.pattern!;
  assert.doesNotMatch(pattern, /\\s/);
  const spelled = new RegExp(pattern, "u");
  const ecma = /^[^\s\u0000-\u001f\u007f](?:[^\u0000-\u001f\u007f]*[^\s\u0000-\u001f\u007f])?$/u;
  for (let code = 0; code <= 0xffff; code += 1) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const character = String.fromCharCode(code);
    for (const value of [character, `${character}a`, `a${character}`, `a${character}b`]) {
      assert.equal(spelled.test(value), ecma.test(value), `U+${code.toString(16).padStart(4, "0")} in ${JSON.stringify(value)}`);
    }
  }
});
test("catalog writers read the stored catalog, never the public projection", () => {
  for (const file of ["../app/api/dacs/index-now/route.ts", "../src/catalog/reindexCore.ts", "../scripts/seed-counterparty-fixture.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /loadStoredCatalog\(\)/, file);
    assert.doesNotMatch(source, /\bloadCatalog\(/, file);
  }
});
test("non-rate search and price filtering still work over the same history", async () => {
  saveCatalog(noRateCatalog());
  for (const [query, expected] of [
    ["category=services&rail=demos-native:DEM&tag=history&q=inspection&priceMax=3", 1],
    ["priceMax=1", 0],
  ] as const) {
    const response = await getListings(new NextRequest(`https://directory.example/api/dacs/listings?${query}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total, expected);
    assertNoNumericMetrics(body);
  }
});
