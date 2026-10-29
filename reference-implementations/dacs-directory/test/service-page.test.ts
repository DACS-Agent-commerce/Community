import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as React from "react";

import { catalogAuthenticationLabel } from "../src/components/directory-evidence-state.js";
import type { ListingSummary, SellerRecord } from "../src/catalog/types.js";

// The app has no react-dom type package; this is the one function the test uses.
const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as {
  renderToStaticMarkup: (element: React.ReactElement) => string;
};

// tsconfig keeps JSX as written for Next, so tsx compiles the page with the
// classic runtime, which calls the global React.
Object.assign(globalThis, { React });

const SELLER_CLAIM = `did:demos:agent:${"a".repeat(64)}`;

const listing = (overrides: Partial<ListingSummary> = {}): ListingSummary => ({
  listingId: "service",
  version: 1,
  contentHash: "b".repeat(64),
  anchor: { kind: "storage-program", locator: `stor-${"c".repeat(40)}` },
  seller: { primaryClaim: SELLER_CLAIM, displayName: "Seller" },
  artifactProfile: "dacs-v0.1",
  offering: { title: "Service", category: "services.other", tags: [] },
  pricing: {},
  status: "active",
  catalogObservedAt: 1,
  ...overrides,
});

const seller = (listings: ListingSummary[]): SellerRecord => ({
  primaryClaim: SELLER_CLAIM,
  displayName: "Seller",
  cci: [],
  listings,
  deals: [],
  reputation: { completed: 0, totalAgreements: 0, completionRate: null },
  registeredAt: 1,
  lastIndexedAt: 1,
});

/** The text of one "trust at a glance" row, by its heading. */
function evidenceRow(html: string, heading: string): string {
  const row = html.match(new RegExp(`<strong>${heading}</strong><p>(.*?)</p>`));
  assert.ok(row, `the service page renders a "${heading}" evidence row`);
  return row[1];
}

test("the service page labels catalog authentication per profile and leaves transaction readiness unassessed", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "service-page-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  process.env.DACS_DIRECTORY_DATA = data;
  const { saveCatalog } = await import("../src/catalog/store.js");
  const { default: ServicePage } = await import("../app/service/[seller]/[listingId]/[version]/page.js");
  const current = listing();
  const fixture = listing({ listingId: "fixture", anchor: { kind: "fixture", locator: "fixture-listing" }, artifactProfile: undefined });
  saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [seller([current, fixture])] });
  const render = async (served: ListingSummary) => renderToStaticMarkup(await ServicePage({
    params: Promise.resolve({ seller: encodeURIComponent(SELLER_CLAIM), listingId: served.listingId, version: String(served.version) }),
  }));

  const currentHtml = await render(current);
  assert.equal(evidenceRow(currentHtml, "Catalog candidate"), catalogAuthenticationLabel("dacs-v0.1"));
  assert.match(evidenceRow(currentHtml, "Transaction readiness"), /^Unassessed here; buyers must run the current SDK reader/);

  const fixtureHtml = await render(fixture);
  assert.equal(evidenceRow(fixtureHtml, "Catalog candidate"), catalogAuthenticationLabel("fixture-listing"));
  assert.match(evidenceRow(fixtureHtml, "Transaction readiness"), /^Unassessed here/);
});
