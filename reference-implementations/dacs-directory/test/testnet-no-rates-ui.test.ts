import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { createRequire } from "node:module";

const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as { renderToStaticMarkup: (element: React.ReactElement) => string };
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import DirectoryExplorer from "../src/components/DirectoryExplorer.js";
import { ObservedOutcomeBadge } from "../src/components/Badge.js";
import { noRateCatalog, noRateClaim } from "./fixtures/no-rate-catalog.js";

// The app's JSX is normally transformed by Next; tsx uses the classic runtime
// for its jsx:preserve config. Supply that runtime for direct component renders.
Object.assign(globalThis, { React });
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-no-rates-ui-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
const { saveCatalog } = await import("../src/catalog/store.js");
const { default: SellerPage } = await import("../app/seller/[claim]/page.js");
const { default: ServicePage } = await import("../app/service/[seller]/[listingId]/[version]/page.js");
const { default: DiscoverPage } = await import("../app/discover/page.js");
test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));

const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
function renderWithRouter(content: React.ReactNode, query = "") {
  return renderToStaticMarkup(React.createElement(AppRouterContext.Provider, { value: router },
    React.createElement(PathnameContext.Provider, { value: "/discover" },
      React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams(query) },
        content))));
}
function renderDiscovery(query = "") {
  const catalog = noRateCatalog();
  return renderWithRouter(React.createElement(DirectoryExplorer, { sellers: catalog.sellers, indexed: true }), query);
}

function assertNoRates(html: string) {
  assert.match(html, /Completion verification unavailable/);
  assert.match(html, /Observed outcomes: 6, not verified/);
  assert.doesNotMatch(html, /90%\+ completion|\d+\s*strict-verified\s*\/|\b1\s*\/\s*6\b|\d+(?:\.\d+)?\s*(?:%|stars|rating|score)/i);
  assert.doesNotMatch(html, /aria-pressed[^>]*>\s*(?:completion|rating|score)/i);
}

test("rendered discovery keeps observations and inspection links without rate controls or success badges", () => {
  saveCatalog(noRateCatalog());
  const html = renderWithRouter(React.createElement(DiscoverPage));
  assertNoRates(html);
  // The refsVerified figure is not SB-2 or version gated, so it is never labelled an outcome count.
  assert.match(html, /signature-checked bundles; not counted as outcomes/);
  assert.doesNotMatch(html, /observed bundles/);
  assert.match(html, /Explore service/);
  assert.match(html, /\/api\/dacs\/listings\/observed-history\/1/);
  assert.doesNotMatch(html, /badge ok[^>]*>\s*Observed outcomes/);
});

test("rendered seller and service pages preserve aborted evidence and labelled counts without ratios", async () => {
  saveCatalog(noRateCatalog());
  const seller = renderToStaticMarkup(await SellerPage({ params: Promise.resolve({ claim: noRateClaim }) }));
  assertNoRates(seller);
  const ledger = /<tbody>(.*?)<\/tbody>/.exec(seller);
  assert.ok(ledger, "seller renders its deal ledger");
  assert.doesNotMatch(ledger[1], /✓/);
  assert.match(ledger[1], /<td>completed<\/td>/);
  assert.match(seller, /aborted-by-self/);
  assert.match(seller, /aborted-by-other/);
  assert.match(seller, /signature-checked bundles; not counted as outcomes/);
  assert.doesNotMatch(seller, /observed bundles/);
  assert.equal((seller.match(/verify yourself →/g) ?? []).length, 6);
  const service = renderToStaticMarkup(await ServicePage({ params: Promise.resolve({
    seller: noRateClaim, listingId: "observed-history", version: "1",
  }) }));
  assertNoRates(service);
  assert.match(service, /<li><span class="check">–<\/span><div><strong>Completion verification unavailable/);
  assert.match(service, /Inspect service/);
  assert.match(service, /View signed listing artifact/);
});

test("rendered legacy filter and ranking URLs explicitly refuse the query and offer clearing", () => {
  for (const query of [
    "trackRecord=90", "minCompletionRate=0.9", "minRating=5", "sort=completionRate", "minCompletionRate%5B%5D=0.9", "order=asc",
    // Rate and ranking aliases still refuse the request.
    "sortKey=rating", "sortDirection=desc", "direction=desc", "sortOrder=desc", "filter=completionRate",
    "utm_source=x&minRating=5", "fbclid=x&sort=completionRate",
  ]) {
    const html = renderDiscovery(query);
    assert.match(html, /role="alert"/);
    assert.match(html, /unavailable on testnet/);
    assert.match(html, /Clear all filters/);
    assert.doesNotMatch(html, /class="card service-card"/);
  }
  for (const query of ["", "category=services&rail=demos-native:DEM&identityTier=self-declared",
    "utm_source=x", "fbclid=x", "gclid=x", "ref=x", "unknown=x", "utm_source=x&category=services",
    "utm_campaign=rating", "ref=completion_rate", "unknown=score"]) {
    const html = renderDiscovery(query);
    assert.doesNotMatch(html, /role="alert"/, query);
    assert.match(html, /class="card service-card"/, query);
  }
  // A search for a rate word is a text search, not a rate filter.
  assert.doesNotMatch(renderDiscovery("q=rating"), /role="alert"/);
});

test("the verify page's outcome badge is a neutral observation, never a success badge", () => {
  for (const outcome of ["completed", "aborted-by-other"]) {
    const html = renderToStaticMarkup(React.createElement(ObservedOutcomeBadge, { outcome }));
    assert.equal(html, `<span class="badge"><b>observed</b>${outcome}; completion not verified</span>`);
  }
  const source = readFileSync(new URL("../app/verify/page.tsx", import.meta.url), "utf8");
  assert.match(source, /<ObservedOutcomeBadge outcome=\{loaded\.outcome\} \/>/);
  assert.doesNotMatch(source, /outcome === "completed"/);
});
