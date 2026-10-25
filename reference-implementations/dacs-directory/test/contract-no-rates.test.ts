import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import React from "react";
import Ajv2020 from "ajv/dist/2020.js";
import { NextRequest } from "next/server";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { FixtureNode, kitListing, kitSeller, locator, revocationMarker } from "./fixtures/kit-listing.js";
import { noRateCatalog, noRateOutcomes } from "./fixtures/no-rate-catalog.js";

// TP-1 through the merged head's API and pages: a catalog built by the real
// indexer (an active kit Listing and an authenticated tombstone) that also
// retains six observed outcomes, both aborts included, with old numeric
// rates and ratings in storage.
const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as { renderToStaticMarkup: (element: React.ReactElement) => string };
Object.assign(globalThis, { React });
const NOW = Date.UTC(2026, 0, 1);
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-contract-no-rates-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
process.env.DACS_ADMIN_TOKEN = "contract-admin";
process.env.DEMOS_RPC = "https://node.example.org";
delete process.env.DEMOS_NODE_BUILDS;
delete process.env.DEMOS_CHAIN_IDENTITY;
mock.timers.enable({ apis: ["Date"], now: NOW });
const node = new FixtureNode();
globalThis.fetch = node.fetch;
const store = await import("../src/catalog/store.js");
const { indexRegistration } = await import("../src/catalog/indexer.js");
const { listingSummarySchema } = await import("../src/catalog/contracts.js");
const listingsRoute = await import("../app/api/dacs/listings/route.js");
const sellersRoute = await import("../app/api/dacs/sellers/[primaryClaimRef]/route.js");
const inspectRoute = await import("../app/api/dacs/inspect-service/[listingId]/[version]/route.js");
const statusRoute = await import("../app/api/dacs/status/route.js");
const manifestRoute = await import("../app/.well-known/dacs-directory.json/route.js");
const { default: HomePage } = await import("../app/page.js");
const { default: DiscoverPage } = await import("../app/discover/page.js");
const { default: SellerPage } = await import("../app/seller/[claim]/page.js");
const { default: ServicePage } = await import("../app/service/[seller]/[listingId]/[version]/page.js");
test.after(() => {
  mock.timers.reset();
  rmSync(dataDirectory, { recursive: true, force: true });
});

const seller = kitSeller(0x41);
const active = kitListing(seller, { notBefore: NOW - 60_000 });
const withdrawn = kitListing(seller, { notBefore: NOW - 60_000, listingId: "kit-withdrawn-report" });
const marker = revocationMarker(seller, withdrawn, NOW);
node.anchor(locator(0x1), seller.owner, active);
node.anchor(locator(0x2), seller.owner, withdrawn);
node.anchor(locator(0x3), seller.owner, marker);
store.admitRevocationCandidates(contentHash(withdrawn), [{ locator: locator(0x3), owner: seller.owner }]);
const record = await indexRegistration(
  { primaryClaim: seller.claim, displayName: "Kit Seller", listingAnchors: [locator(0x1), locator(0x2)] },
  undefined,
  async () => { throw new Error("identity unavailable"); },
);
// Retained history: six observed outcomes with the numeric rates and signed
// ratings an earlier writer stored.
const history = noRateCatalog().sellers[0];
record.deals = history.deals.map((deal) => ({
  ...deal,
  category: "services.market-report",
  owners: { ...deal.owners, seller: seller.claim },
  ratings: deal.ratings?.map((rating) => ({ ...rating, target: seller.claim })),
}));
record.reputation = Object.assign({ ...history.reputation }, { reputationScore: 7 });
store.saveCatalog({ catalogVersion: "1", generatedAt: NOW, sellers: [record] });

const request = (path: string) => new NextRequest(`https://directory.example.org${path}`);
const json = async (response: Response) => {
  assert.equal(response.status, 200);
  return response.json() as Promise<Record<string, unknown>>;
};

/** Every number published under a rate, rating or score name, and every rating value. */
function publishedMetrics(value: unknown, path = "$"): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, member]) => [
    ...(/(?:rate|rating|score)$/i.test(key) && typeof member === "number" ? [`${path}.${key}`] : []),
    ...(key === "value" && /ratings/.test(path) && member !== null ? [`${path}.${key}`] : []),
    ...publishedMetrics(member, `${path}.${key}`),
  ]);
}

test("the listings, seller and inspection APIs publish observed history in the head's schema without a rate, rating or score", async () => {
  const listings = await json(await listingsRoute.GET(request("/api/dacs/listings")));
  const sellerView = await json(await sellersRoute.GET(request(`/api/dacs/sellers/${encodeURIComponent(seller.claim)}`),
    { params: Promise.resolve({ primaryClaimRef: seller.claim }) }));
  const inspection = await json(await inspectRoute.GET(
    request(`/api/dacs/inspect-service/${String(active.listingId)}/1?seller=${encodeURIComponent(seller.claim)}`),
    { params: Promise.resolve({ listingId: String(active.listingId), version: "1" }) }));
  for (const body of [listings, sellerView, inspection]) assert.deepEqual(publishedMetrics(body), []);

  const validate = new Ajv2020({ validateFormats: false }).compile(listingSummarySchema);
  const summaries = [...listings.listings as object[], ...sellerView.listings as object[]];
  for (const summary of summaries) assert.ok(validate(summary), JSON.stringify(validate.errors));
  assert.deepEqual((listings.listings as Array<{ status: string }>).map((row) => row.status).sort(), ["active", "revoked"]);

  const reputation = sellerView.reputation as Record<string, unknown>;
  assert.equal(reputation.metricsUnavailableReason, "Completion verification unavailable");
  assert.equal(reputation.observedOutcomesLabel, "Observed outcomes: 6, not verified");
  assert.match(String(reputation.completedLabel), /not verified/);
  assert.equal((reputation.bundleRefs as unknown[]).length, 6);
  assert.deepEqual((sellerView.deals as Array<{ outcome: string }>).map((deal) => deal.outcome), noRateOutcomes);
  const hint = (listings.listings as Array<{ status: string; reputationHint: Record<string, unknown> }>)
    .find((row) => row.status === "active")!.reputationHint;
  assert.equal(hint.observedOutcomesLabel, "Observed outcomes: 6, not verified");
});

test("rate filters and ranking are refused by the listings API and change nothing on the seller API", async () => {
  const sellerBody = async (query: string) => (await sellersRoute.GET(
    request(`/api/dacs/sellers/${encodeURIComponent(seller.claim)}${query}`),
    { params: Promise.resolve({ primaryClaimRef: seller.claim }) })).text();
  const plain = await sellerBody("");
  for (const query of ["minCompletionRate=0.9", "minRating=4", "maxFaultRate=0.1", "reputationScore=3", "trackRecord=90",
    "sort=completionRate", "order=desc", "rank=score", "filter%5BcompletionRate%5D=0.9"]) {
    const response = await listingsRoute.GET(request(`/api/dacs/listings?${query}`));
    assert.equal(response.status, 400, query);
    assert.match((await response.json()).error, /unavailable on testnet under TP-1/, query);
    assert.equal(await sellerBody(`?${query}`), plain, query);
  }
  for (const query of ["category=services", "q=report", "rail=demos-native:DEM", "priceMax=3"]) {
    assert.equal((await listingsRoute.GET(request(`/api/dacs/listings?${query}`))).status, 200, query);
  }
});

test("the status endpoint and the manifest offer no rate filter and publish no metric", async () => {
  const status = await json(await statusRoute.GET(request("/api/dacs/status")));
  const manifest = await json(await manifestRoute.GET(request("/.well-known/dacs-directory.json")));
  assert.deepEqual(publishedMetrics(status), []);
  assert.deepEqual(publishedMetrics(manifest), []);
  assert.equal((manifest.filters as string[]).some((name) => /rate|rating|score|sort|rank/i.test(name)), false);
  assert.deepEqual(manifest.restrictions, ["TP-1"]);
});

test("rendered pages keep each observed outcome and the labelled counts without rates, scores or rate controls", async () => {
  const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
  const routed = (content: React.ReactNode, query: string) => renderToStaticMarkup(
    React.createElement(AppRouterContext.Provider, { value: router },
      React.createElement(PathnameContext.Provider, { value: "/discover" },
        React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams(query) }, content))));
  const pages = {
    home: renderToStaticMarkup(React.createElement(HomePage)),
    discover: routed(React.createElement(DiscoverPage), ""),
    seller: renderToStaticMarkup(await SellerPage({ params: Promise.resolve({ claim: seller.claim }) })),
    service: renderToStaticMarkup(await ServicePage({ params: Promise.resolve({ seller: seller.claim, listingId: String(active.listingId), version: "1" }) })),
  };
  for (const [name, html] of Object.entries(pages)) {
    assert.doesNotMatch(html, /\d+(?:\.\d+)?\s*(?:%|stars?\b)|\b(?:rating|score)\s*[:=]?\s*\d|\b1\s*\/\s*6\b|90%\+ completion/i, name);
  }
  for (const name of ["discover", "seller", "service"] as const) {
    assert.match(pages[name], /Completion verification unavailable/, name);
    assert.match(pages[name], /Observed outcomes: 6, not verified/, name);
  }
  for (const outcome of noRateOutcomes) assert.match(pages.seller, new RegExp(`<td>${outcome}</td>`), outcome);
  assert.doesNotMatch(pages.service, /kit-withdrawn-report/, "a withdrawn offer is not shown as a service");
  const refused = routed(React.createElement(DiscoverPage), "minRating=4");
  assert.match(refused, /role="alert"/);
  assert.doesNotMatch(refused, /class="card service-card"/);
});
