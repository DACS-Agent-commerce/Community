import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

// The cached store module keeps this directory for the lifetime of the file.
const data = mkdtempSync(join(tmpdir(), "service-page-"));
process.env.DACS_DIRECTORY_DATA = data;
const { saveCatalog } = await import("../src/catalog/store.js");
const { default: ServicePage } = await import("../app/service/[seller]/[listingId]/[version]/page.js");
test.beforeEach(() => assert.ok(existsSync(data), "the shared data directory exists during each test"));
test.after(() => {
  assert.ok(existsSync(data), "the shared data directory survives until file teardown");
  rmSync(data, { recursive: true, force: true });
  assert.equal(existsSync(data), false, "file teardown removes the shared data directory");
});

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

test("the service page labels catalog authentication per profile and leaves transaction readiness unassessed", async () => {
  const current = listing({ listingId: "authentication-service" });
  const fixture = listing({ listingId: "authentication-fixture", anchor: { kind: "fixture", locator: "fixture-listing" }, artifactProfile: undefined });
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

/** The structured data object the page embeds for search engines. */
function structuredDataOf(html: string): { identifier: string } {
  const script = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
  assert.ok(script, "the service page embeds JSON-LD");
  return JSON.parse(script[1]);
}

test("the service page structured data identifier differs between sellers that publish the same listing ID and version", async () => {
  const otherClaim = `did:demos:agent:${"d".repeat(64)}`;
  const first = listing({ listingId: "identifier-service" });
  const second = listing({ listingId: "identifier-service", seller: { primaryClaim: otherClaim, displayName: "Other seller" } });
  saveCatalog({
    catalogVersion: "1",
    generatedAt: 1,
    sellers: [seller([first]), { ...seller([second]), primaryClaim: otherClaim, displayName: "Other seller" }],
  });
  const identifierFor = async (claim: string) => structuredDataOf(renderToStaticMarkup(await ServicePage({
    params: Promise.resolve({ seller: encodeURIComponent(claim), listingId: first.listingId, version: String(first.version) }),
  }))).identifier;

  const firstIdentifier = await identifierFor(SELLER_CLAIM);
  const secondIdentifier = await identifierFor(otherClaim);
  assert.equal(firstIdentifier, `${SELLER_CLAIM}/identifier-service@1`);
  assert.equal(secondIdentifier, `${otherClaim}/identifier-service@1`);
  assert.notEqual(firstIdentifier, secondIdentifier);
});

test("the service page keeps the contact button after a failed check and shows how to buy", async () => {
  const endpoint = "https://seller.example/agent";
  // What the plugin can buy: a fixed price paid in DEM through a signed pay-dem phase.
  const demPhase = [{ kind: "pay-dem", rail: "demos-native:DEM" }];
  // …after one fixed-price negotiation and one commit phase, in that order.
  const flow = ["negotiate-fixed-price", "commit-agreement"];
  const fixedDem = (overrides: Partial<ListingSummary>) => listing({
    pricing: { kind: "fixed", priceHint: "1", currency: "DEM" },
    ...overrides,
    offering: {
      flowPhases: flow,
      ...(overrides.offering ?? { title: "Service", category: "services.other", tags: [], rails: ["demos-native:DEM"], paymentPhases: demPhase }),
    },
  });
  const withFlow = (listingId: string, flowPhases?: string[]) => fixedDem({
    listingId,
    offering: { title: "Service", category: "services.other", tags: [], rails: ["demos-native:DEM"], paymentPhases: demPhase, ...(flowPhases ? { flowPhases } : {}) },
  });
  const noFlowKey = (listingId: string) => {
    const served = withFlow(listingId);
    delete served.offering.flowPhases;
    return served;
  };
  const online = fixedDem({ listingId: "online", publicEndpoint: endpoint, reachabilityHint: { status: "reachable", checkedAt: Date.now() } });
  const offline = fixedDem({ listingId: "offline", publicEndpoint: endpoint, reachabilityHint: { status: "unreachable", checkedAt: Date.now() } });
  const stale = fixedDem({ listingId: "stale", publicEndpoint: endpoint, reachabilityHint: { status: "unreachable", checkedAt: Date.now() - 2 * 60 * 60_000 } });
  const fixture = fixedDem({ listingId: "fixture", anchor: { kind: "fixture", locator: "fixture-listing" }, artifactProfile: undefined });
  const x402 = fixedDem({ listingId: "x402", offering: { title: "Service", category: "services.other", tags: [], rails: ["x402:default"] } });
  // `pay-dem` is a historical alias on current listings: there x402 is the only usable rail.
  const aliasX402 = fixedDem({ listingId: "alias-x402", offering: { title: "Service", category: "services.other", tags: [], rails: ["pay-dem", "x402:default"] } });
  const legacyPayDem = fixedDem({ listingId: "legacy-pay-dem", artifactProfile: "legacy-sdk-v0.1", offering: { title: "Service", category: "services.other", tags: [], rails: ["pay-dem"] } });
  // The rail is accepted, but no signed phase pays it in DEM: the plugin cannot select it.
  const x402Phase = fixedDem({ listingId: "x402-phase", offering: { title: "Service", category: "services.other", tags: [], rails: ["demos-native:DEM"], paymentPhases: [{ kind: "pay-x402", rail: "x402:default" }] } });
  const mismatchedPhase = fixedDem({ listingId: "mismatched-phase", offering: { title: "Service", category: "services.other", tags: [], rails: ["demos-native:DEM"], paymentPhases: [{ kind: "pay-dem", rail: "demos-native:OTHER" }] } });
  const mixedPhases = fixedDem({ listingId: "mixed-phases", offering: { title: "Service", category: "services.other", tags: [], rails: ["demos-native:DEM"], paymentPhases: [{ kind: "pay-x402", rail: "demos-native:DEM" }, ...demPhase] } });
  const otherRailPhase = fixedDem({ listingId: "other-rail-phase", offering: { title: "Service", category: "services.other", tags: [], rails: ["demos-native:DEM", "x402:default"], paymentPhases: [...demPhase, { kind: "pay-x402", rail: "x402:default" }] } });
  const noPhases = fixedDem({ listingId: "no-phases", offering: { title: "Service", category: "services.other", tags: [], rails: ["demos-native:DEM"] } });
  const auction = fixedDem({ listingId: "auction", pricing: { kind: "auction", currency: "DEM" } });
  const usd = fixedDem({ listingId: "usd", pricing: { kind: "fixed", priceHint: "1", currency: "USD" } });
  const noAmount = fixedDem({ listingId: "no-amount", pricing: { kind: "fixed", currency: "DEM" } });
  const zero = fixedDem({ listingId: "zero", pricing: { kind: "fixed", priceHint: "0", currency: "DEM" } });
  const subUnit = fixedDem({ listingId: "sub-unit", pricing: { kind: "fixed", priceHint: "0.0000000001", currency: "DEM" } });
  const finest = fixedDem({ listingId: "finest", pricing: { kind: "fixed", priceHint: "0.000000001", currency: "DEM" } });
  const noNegotiation = withFlow("no-negotiation", ["commit-agreement"]);
  const noCommit = withFlow("no-commit", ["negotiate-fixed-price"]);
  const noFlow = withFlow("no-flow", []);
  const twoNegotiations = withFlow("two-negotiations", ["negotiate-fixed-price", "negotiate-fixed-price", "commit-agreement"]);
  const twoCommits = withFlow("two-commits", ["negotiate-fixed-price", "commit-agreement", "commit-agreement"]);
  const misordered = withFlow("misordered", ["commit-agreement", "negotiate-fixed-price"]);
  const otherNegotiation = withFlow("other-negotiation", ["negotiate-rfq", "commit-agreement"]);
  const unindexedFlow = noFlowKey("unindexed-flow");
  saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [seller([online, offline, stale, fixture, x402, aliasX402, legacyPayDem, x402Phase, mismatchedPhase, mixedPhases, otherRailPhase, noPhases, auction, usd, noAmount, zero, subUnit, finest, noNegotiation, noCommit, noFlow, twoNegotiations, twoCommits, misordered, otherNegotiation, unindexedFlow])] });
  const render = async (served: ListingSummary) => renderToStaticMarkup(await ServicePage({
    params: Promise.resolve({ seller: encodeURIComponent(SELLER_CLAIM), listingId: served.listingId, version: String(served.version) }),
  }));

  const onlineHtml = await render(online);
  assert.match(onlineHtml, /Begin with agent/);
  assert.doesNotMatch(onlineHtml, /Last check failed/);
  assert.match(onlineHtml, /Buy through your AI assistant/);
  assert.match(onlineHtml, /The planned DACS plugin will let/, "the buying path is described as not yet usable");
  const buyBox = onlineHtml.slice(onlineHtml.indexOf('id="buy-heading"'), onlineHtml.indexOf("</section>", onlineHtml.indexOf('id="buy-heading"')));
  assert.match(buyBox, /title="online@1"/, "the listing to ask for is online@1");
  assert.match(buyBox, new RegExp(`title="${SELLER_CLAIM}"`), "the box names the seller, since listing IDs are unique only per seller");

  const offlineHtml = await render(offline);
  assert.match(offlineHtml, /Begin with agent/, "one failed check is a hint, so the link is kept");
  assert.match(offlineHtml, new RegExp(`href="${endpoint}"`));
  assert.match(offlineHtml, /Last check failed/);
  assert.match(offlineHtml, /unreachable in the Directory&#x27;s last check/, "the buy box warns a purchase may fail");
  assert.doesNotMatch(offlineHtml, /offline right now/);

  const staleHtml = await render(stale);
  assert.match(staleHtml, /Begin with agent/, "an hours-old failed check does not hide the button");
  assert.doesNotMatch(staleHtml, /Last check failed/);

  assert.doesNotMatch(await render(fixture), /Buy through your AI assistant/, "a fixture is not offered for sale");
  assert.doesNotMatch(await render(x402), /Buy through your AI assistant/, "the plugin does not pay over x402");
  assert.doesNotMatch(await render(aliasX402), /Buy through your AI assistant/, "pay-dem on a current listing is only an alias");
  assert.match(await render(legacyPayDem), /Buy through your AI assistant/, "pay-dem pays on a legacy listing");
  assert.doesNotMatch(await render(x402Phase), /Buy through your AI assistant/, "a DEM rail with only an x402 payment phase is not payable in DEM");
  assert.doesNotMatch(await render(mismatchedPhase), /Buy through your AI assistant/, "the pay-dem phase must name the DEM rail");
  assert.doesNotMatch(await render(mixedPhases), /Buy through your AI assistant/, "the SDK refuses a rail that phases of different kinds name");
  assert.doesNotMatch(await render(otherRailPhase), /Buy through your AI assistant/, "every payment phase must bind the DEM rail");
  assert.doesNotMatch(await render(noPhases), /Buy through your AI assistant/, "a current summary without phases shows no box until reindexed");
  assert.doesNotMatch(await render(auction), /Buy through your AI assistant/, "the plugin buys only at a fixed price");
  assert.doesNotMatch(await render(usd), /Buy through your AI assistant/, "the plugin pays only DEM prices");
  assert.doesNotMatch(await render(noAmount), /Buy through your AI assistant/, "no published amount, nothing to buy");
  assert.doesNotMatch(await render(zero), /Buy through your AI assistant/, "a zero amount is not an offer");
  assert.doesNotMatch(await render(subUnit), /Buy through your AI assistant/, "DEM has nine decimal places");
  assert.match(await render(finest), /Buy through your AI assistant/, "one base unit is payable");
  assert.doesNotMatch(await render(noNegotiation), /Buy through your AI assistant/, "a pipeline without a negotiation phase cannot be bought");
  assert.doesNotMatch(await render(noCommit), /Buy through your AI assistant/, "a pipeline without a commit phase cannot be bought");
  assert.doesNotMatch(await render(noFlow), /Buy through your AI assistant/, "a pipeline with neither phase cannot be bought");
  assert.doesNotMatch(await render(twoNegotiations), /Buy through your AI assistant/, "the flow expects exactly one negotiation");
  assert.doesNotMatch(await render(twoCommits), /Buy through your AI assistant/, "the flow expects exactly one commit");
  assert.doesNotMatch(await render(misordered), /Buy through your AI assistant/, "the commit must follow the negotiation");
  assert.doesNotMatch(await render(otherNegotiation), /Buy through your AI assistant/, "the plugin negotiates only a fixed price");
  assert.doesNotMatch(await render(unindexedFlow), /Buy through your AI assistant/, "a current summary without flow phases shows no box until reindexed");
});

// This runs after the page cases, while the cached store must still be usable.
test("the service-page data directory remains available through the last test", () => {
  assert.ok(existsSync(process.env.DACS_DIRECTORY_DATA!), "the store directory still exists after the page cases");
});
