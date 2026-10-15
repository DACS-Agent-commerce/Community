import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import DirectoryExplorer from "../src/components/DirectoryExplorer.js";
import { noRateCatalog, noRateClaim } from "./fixtures/no-rate-catalog.js";
import { projectTestnetCatalog } from "../src/catalog/testnetMetrics.js";

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
  const catalog = projectTestnetCatalog(noRateCatalog());
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
  assert.match(html, /observed bundles; completion not verified/);
  assert.match(html, /Explore service/);
  assert.match(html, /\/api\/dacs\/listings\/observed-history\/1/);
  assert.doesNotMatch(html, /badge ok[^>]*>\s*Observed outcomes/);
});

test("rendered seller and service pages preserve aborted evidence and labelled counts without ratios", async () => {
  saveCatalog(noRateCatalog());
  const seller = renderToStaticMarkup(await SellerPage({ params: Promise.resolve({ claim: noRateClaim }) }));
  assertNoRates(seller);
  assert.match(seller, /aborted-by-self/);
  assert.match(seller, /aborted-by-other/);
  assert.equal((seller.match(/verify yourself →/g) ?? []).length, 6);
  const service = renderToStaticMarkup(await ServicePage({ params: Promise.resolve({
    seller: noRateClaim, listingId: "observed-history", version: "1",
  }) }));
  assertNoRates(service);
  assert.match(service, /Inspect service/);
  assert.match(service, /View signed listing artifact/);
});

test("rendered legacy filter and ranking URLs explicitly refuse the query and offer clearing", () => {
  for (const query of ["trackRecord=90", "minCompletionRate=0.9", "minRating=5", "sort=completionRate", "minCompletionRate%5B%5D=0.9", "order=asc"]) {
    const html = renderDiscovery(query);
    assert.match(html, /role="alert"/);
    assert.match(html, /unavailable on testnet/);
    assert.match(html, /Clear all filters/);
    assert.doesNotMatch(html, /class="card service-card"/);
  }
});
