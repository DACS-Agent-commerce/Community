import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { NextRequest } from "next/server";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { isListing } from "@kynesyslabs/dacs/artifacts";
import { FixtureNode, kitListing, kitSeller, locator, revocationMarker, type Artifact, type KitSeller } from "./fixtures/kit-listing.js";
import { clientSearchParams, directoryAdmission, parseListingsPage, projectSummary, catalogSurfaceDisposition } from "./fixtures/sdk-client-directory-reader.js";

// Directory/client contract: a seller-kit Listing through registration,
// index-now, lookup and the SDK client's purchase admission rules, against
// the real routes, indexer and store with an in-memory Demos node.
const NOW = Date.UTC(2026, 0, 1);
const DAY = 24 * 60 * 60 * 1000;
const ADMIN = "contract-admin";
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-contract-kit-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
process.env.DACS_ADMIN_TOKEN = ADMIN;
process.env.DEMOS_RPC = "https://node.example.org";
delete process.env.DEMOS_NODE_BUILDS;
delete process.env.DEMOS_CHAIN_IDENTITY;
mock.timers.enable({ apis: ["Date"], now: NOW });
const node = new FixtureNode();
globalThis.fetch = node.fetch;
const store = await import("../src/catalog/store.js");
const { activeCatalogListings } = await import("../src/catalog/discovery.js");
const register = await import("../app/api/dacs/register/route.js");
const indexNow = await import("../app/api/dacs/index-now/route.js");
const listingsRoute = await import("../app/api/dacs/listings/route.js");
const listingRoute = await import("../app/api/dacs/listings/[listingId]/[version]/route.js");
const sellersRoute = await import("../app/api/dacs/sellers/[primaryClaimRef]/route.js");
test.after(() => {
  mock.timers.reset();
  rmSync(dataDirectory, { recursive: true, force: true });
});

const request = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`https://directory.example.org${path}`, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });

async function registerAndIndex(seller: KitSeller, anchors: string[]): Promise<Response> {
  const registered = await register.POST(request("/api/dacs/register", { primaryClaim: seller.claim, displayName: "Kit Seller", listingAnchors: anchors }));
  assert.equal(registered.status, 200, await registered.clone().text());
  return reindex(seller);
}

const reindex = (seller: KitSeller) =>
  indexNow.POST(request("/api/dacs/index-now", { claim: seller.claim }, { authorization: `Bearer ${ADMIN}` }));

async function listingsFor(seller: KitSeller): Promise<Array<Record<string, unknown>>> {
  const response = await listingsRoute.GET(request(`/api/dacs/listings?${clientSearchParams(seller.claim)}`));
  assert.equal(response.status, 200);
  return (await response.json()).listings;
}

async function sellerListings(seller: KitSeller): Promise<Array<Record<string, unknown>>> {
  const response = await sellersRoute.GET(request(`/api/dacs/sellers/${encodeURIComponent(seller.claim)}`),
    { params: Promise.resolve({ primaryClaimRef: seller.claim }) });
  assert.equal(response.status, 200);
  return (await response.json()).listings;
}

const listingDetail = (listing: Artifact, claim: string) => listingRoute.GET(
  request(`/api/dacs/listings/${String(listing.listingId)}/${String(listing.listingVersion)}?seller=${encodeURIComponent(claim)}`),
  { params: Promise.resolve({ listingId: String(listing.listingId), version: String(listing.listingVersion) }) },
);

/** The SDK client's purchase admission over this Directory's listings and detail APIs and the node. */
async function clientAdmission(seller: KitSeller, listing: Artifact, checkedAt: number) {
  const page = parseListingsPage({ listings: await listingsFor(seller) });
  const summary = page.listings.find((row) => row.listingId === listing.listingId &&
    row.version === listing.listingVersion && row.seller.primaryClaim === seller.claim) ?? null;
  const response = await listingDetail(listing, seller.claim);
  assert.equal(response.status, 200);
  const readback = summary ? node.programs.get(summary.anchor.locator) ?? null : null;
  return directoryAdmission({
    summary, detail: await response.json(), readback, checkedAt,
    coordinates: { listingId: String(listing.listingId), version: Number(listing.listingVersion), seller: seller.claim },
  });
}

function publish(seller: KitSeller, at: string, options: Partial<Parameters<typeof kitListing>[1]> = {}, owner = seller.owner): Artifact {
  const listing = kitListing(seller, { notBefore: NOW - 60_000, ...options });
  node.anchor(at, owner, listing);
  return listing;
}

test("a kit Listing registered by an index-now hint is found and parsed by the SDK client rules through every lookup", async () => {
  const seller = kitSeller(0x31);
  const listing = publish(seller, locator(0x101));
  const indexed = await registerAndIndex(seller, [locator(0x101)]);
  assert.equal(indexed.status, 200);
  assert.equal((await indexed.json()).listings, 1);

  const expected = {
    listingId: "kit-market-report", version: 1, contentHash: contentHash(listing),
    anchor: { kind: "storage-program", locator: locator(0x101) },
    seller: { primaryClaim: seller.claim, displayName: "Kit Seller" },
    title: "Kit market report", description: "A market report delivered as a public storage program.",
    category: "services.market-report", tags: ["kit", "report"], rails: ["demos-native:DEM"],
    pricingHint: { kind: "fixed", priceHint: "2.5", currency: "DEM", unit: undefined },
    publicEndpoint: "https://seller.example.org/agent", artifactProfile: "dacs-v0.1",
    status: "active", revocationBinding: undefined, catalogObservedAt: NOW,
  };
  for (const rows of [await listingsFor(seller), await sellerListings(seller)]) {
    assert.deepEqual(parseListingsPage({ listings: rows }), { listings: [expected], rejected: 0, cursor: undefined, total: undefined });
    assert.equal((rows[0].transactionReadiness as { disposition?: string } | undefined)?.disposition, "unassessed");
  }

  const admission = await clientAdmission(seller, listing, NOW + 60_000);
  assert.deepEqual(admission.checks.filter((check) => !check.ok), []);
  assert.equal(admission.revocation, "absent");
  assert.equal(admission.eligible, true);
});

test("an authenticated revocation turns the kit Listing into a tombstone that removes purchase eligibility", async () => {
  const seller = kitSeller(0x32);
  const listing = publish(seller, locator(0x201));
  assert.equal((await registerAndIndex(seller, [locator(0x201)])).status, 200);
  const marker = revocationMarker(seller, listing, NOW);
  node.anchor(locator(0x202), seller.owner, marker);
  // The chain scan queues markers it finds; this is that queue entry.
  store.admitRevocationCandidates(contentHash(listing), [{ locator: locator(0x202), owner: seller.owner }]);
  assert.equal((await reindex(seller)).status, 200);

  const [row] = await listingsFor(seller);
  assert.equal(row.status, "revoked");
  assert.deepEqual(row.revocation, {
    sellerPrimaryClaim: seller.claim, listingId: listing.listingId, listingVersion: 1,
    listingContentHash: contentHash(listing),
    logicalAddress: `dacs1-revoked:${encodeURIComponent(seller.claim)}:${String(listing.listingId)}:v1`,
    markerAnchor: { kind: "storage-program", locator: locator(0x202) },
    markerContentHash: contentHash(marker),
  });
  assert.equal(activeCatalogListings(store.loadCatalog()).some((offer) => offer.contentHash === contentHash(listing)), false);

  const admission = await clientAdmission(seller, listing, NOW + 60_000);
  assert.equal(admission.eligible, false);
  assert.notEqual(admission.revocation, "absent");
  // The served binding names this Listing under the SDK reader's RB-2 rules.
  assert.equal(catalogSurfaceDisposition({ kind: "catalog", status: "revoked", readStatus: "ok", catalogObservedAt: NOW,
    binding: row.revocation as object }, listing, NOW + 60_000), "marker-required");
});

test("a read never refreshes the catalog observation, so a stale one is indeterminate for the client", async () => {
  const seller = kitSeller(0x33);
  const listing = publish(seller, locator(0x301));
  assert.equal((await registerAndIndex(seller, [locator(0x301)])).status, 200);
  mock.timers.setTime(NOW + DAY + 1);
  try {
    const [row] = await listingsFor(seller);
    assert.equal(row.catalogObservedAt, NOW, "the observation is the index time, not the read time");
    assert.equal((row.transactionReadiness as { disposition?: string }).disposition, "unassessed");
    const stale = await clientAdmission(seller, listing, NOW + DAY + 1);
    assert.deepEqual(stale.checks.filter((check) => !check.ok).map((check) => check.name), ["catalog-observation-fresh"]);
    assert.equal(stale.revocation, "indeterminate");
    assert.equal(stale.eligible, false);
  } finally {
    mock.timers.setTime(NOW);
  }
});

test("a missing catalog observation is served missing, so it is indeterminate for the client", async () => {
  const seller = kitSeller(0x3e);
  const listing = publish(seller, locator(0xd01));
  assert.equal((await registerAndIndex(seller, [locator(0xd01)])).status, 200);
  const catalog = store.loadStoredCatalog();
  const record = catalog.sellers.find((s) => s.primaryClaim === seller.claim)!;
  Reflect.deleteProperty(record.listings[0], "catalogObservedAt");
  store.saveCatalog(catalog);

  const [row] = await listingsFor(seller);
  assert.equal(Object.hasOwn(row, "catalogObservedAt"), false, "a missing observation is never filled in");
  assert.equal(projectSummary(row)?.catalogObservedAt, undefined);
  const admission = await clientAdmission(seller, listing, NOW);
  assert.equal(admission.revocation, "indeterminate");
  assert.equal(admission.eligible, false);
});

test("catalog readiness never grants purchase eligibility: a stored readiness claim is not republished", async () => {
  const seller = kitSeller(0x34);
  publish(seller, locator(0x401));
  assert.equal((await registerAndIndex(seller, [locator(0x401)])).status, 200);
  const catalog = store.loadStoredCatalog();
  const record = catalog.sellers.find((s) => s.primaryClaim === seller.claim)!;
  Object.assign(record.listings[0], { transactionReadiness: { disposition: "ready", reason: "an older writer's claim" } });
  store.saveCatalog(catalog);

  for (const row of [...await listingsFor(seller), ...await sellerListings(seller)]) {
    assert.equal((row.transactionReadiness as { disposition: string }).disposition, "unassessed");
    assert.equal(Object.hasOwn(projectSummary(row) ?? {}, "transactionReadiness"), false, "the client never reads readiness");
  }
});

test("a missing revocation is never filled from the legacy revocationBinding field", async () => {
  const seller = kitSeller(0x35);
  const listing = publish(seller, locator(0x501));
  assert.equal((await registerAndIndex(seller, [locator(0x501)])).status, 200);
  const catalog = store.loadStoredCatalog();
  const record = catalog.sellers.find((s) => s.primaryClaim === seller.claim)!;
  const legacyBinding = {
    sellerPrimaryClaim: seller.claim, listingId: listing.listingId, listingVersion: 1, listingContentHash: contentHash(listing),
    logicalAddress: `dacs1-revoked:${encodeURIComponent(seller.claim)}:${String(listing.listingId)}:v1`,
    markerAnchor: { kind: "storage-program", locator: locator(0x502) }, markerContentHash: "e".repeat(64),
  };
  Object.assign(record.listings[0], { status: "revoked", revocationBinding: legacyBinding });
  store.saveCatalog(catalog);

  assert.equal(store.loadStoredCatalog().sellers.find((s) => s.primaryClaim === seller.claim)?.listings[0].revocation, undefined);
  for (const rows of [await listingsFor(seller), await sellerListings(seller)]) {
    assert.deepEqual(rows, [], "a revoked row without its normative binding is not a tombstone");
  }
  assert.doesNotMatch(JSON.stringify(store.loadCatalog()), /revocationBinding/);
});

test("a mismatched seller is refused: another seller's Listing or an anchor another key owns", async () => {
  const seller = kitSeller(0x36);
  const other = kitSeller(0x37);
  publish(other, locator(0x601));
  const ownedByOther = publish(seller, locator(0x602), {}, other.owner);
  const indexed = await registerAndIndex(seller, [locator(0x601), locator(0x602)]);
  assert.equal((await indexed.json()).listings, 0);
  assert.deepEqual(await listingsFor(seller), []);
  assert.equal(store.listingRejectionCode(locator(0x601), seller.claim), "SELLER_CLAIM_BINDING");
  assert.equal(store.listingRejectionCode(locator(0x602), seller.claim), "OWNER_CLAIM_BINDING");
  assert.equal((await listingDetail(ownedByOther, seller.claim)).status, 404);
});

test("a declared content hash that differs from the signed Listing is refused", async () => {
  const seller = kitSeller(0x38);
  publish(seller, locator(0x701));
  // An authenticated well-known crawl records the hash the seller's index declares.
  store.saveRegistrations([...store.loadRegistrations(), {
    primaryClaim: seller.claim, displayName: "Kit Seller", listingAnchors: [locator(0x701)],
    listingContentHashes: { [locator(0x701)]: `sha256-${"0".repeat(64)}` }, authenticatedHashDeclarations: [locator(0x701)],
  }]);
  assert.equal((await (await reindex(seller)).json()).listings, 0);
  assert.deepEqual(await listingsFor(seller), []);
  assert.equal(store.listingRejectionCode(locator(0x701), seller.claim), "DECLARED_CONTENT_HASH_MISMATCH");
});

test("chain bytes that changed after indexing are refused by the detail API", async () => {
  const seller = kitSeller(0x39);
  const listing = publish(seller, locator(0x801));
  assert.equal((await registerAndIndex(seller, [locator(0x801)])).status, 200);
  publish(seller, locator(0x801), { title: "Replaced terms" });
  const response = await listingDetail(listing, seller.claim);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /listing anchor failed verification/);
});

test("a Listing whose signed endpoint is not a safe HTTPS URL is refused", async () => {
  const seller = kitSeller(0x3a);
  const listing = publish(seller, locator(0x901), { publicEndpoint: "https://operator@seller.example.org/agent" });
  assert.equal(isListing(listing), true, "the pinned SDK reader accepts it; the Directory profile refuses it");
  assert.equal((await (await registerAndIndex(seller, [locator(0x901)])).json()).listings, 0);
  assert.deepEqual(await listingsFor(seller), []);
  assert.equal(store.listingRejectionCode(locator(0x901), seller.claim), "NORMATIVE_LISTING_INVALID");
});

test("an unsupported Listing (an APR-1 pay-alternative pipeline) is refused", async () => {
  const seller = kitSeller(0x3b);
  const alternatives = [{ railId: "demos-native:DEM", railVersion: 1 }, { railId: "pay-x402" }];
  const listing = publish(seller, locator(0xa01), {
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-payee-bound-agreement" },
      { kind: "pay-alternative", parameters: { alternatives } },
      { kind: "deliver-storage-program" },
    ],
    acceptedRails: alternatives,
  });
  assert.equal(isListing(listing), true, "the pinned SDK reader accepts it; the Directory profile refuses it");
  assert.equal((await (await registerAndIndex(seller, [locator(0xa01)])).json()).listings, 0);
  assert.deepEqual(await listingsFor(seller), []);
  assert.equal(store.listingRejectionCode(locator(0xa01), seller.claim), "NORMATIVE_LISTING_INVALID");
});

test("an unreadable Demos node leaves the catalog unchanged with a clear unavailable result", async () => {
  const seller = kitSeller(0x3c);
  publish(seller, locator(0xb01));
  const before = store.loadStoredCatalog();
  node.down = true;
  try {
    const response = await registerAndIndex(seller, [locator(0xb01)]);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /could not read the Demos node's chain; catalog not updated/);
  } finally {
    node.down = false;
  }
  assert.deepEqual(store.loadStoredCatalog(), before);
});

test("the detail API reports an unreadable node as unavailable, not as a failed verification or a cached copy", async () => {
  const seller = kitSeller(0x3d);
  const listing = publish(seller, locator(0xc01));
  assert.equal((await registerAndIndex(seller, [locator(0xc01)])).status, 200);
  node.down = true;
  try {
    const response = await listingDetail(listing, seller.claim);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.match(body.error, /listing anchor unavailable/);
    assert.equal(Object.hasOwn(body, "listingId"), false, "no cached listing stands in for the chain bytes");
  } finally {
    node.down = false;
  }
});

test("refused listing queries carry no listings array a client could read as an empty catalog", async () => {
  for (const query of ["minCompletionRate=0.9", "sort=completionRate", "limit=0", "profile=unknown"]) {
    const response = await listingsRoute.GET(request(`/api/dacs/listings?${query}`));
    assert.equal(response.status, 400, query);
    const body = await response.json();
    assert.equal(Object.hasOwn(body, "listings"), false, query);
    assert.throws(() => parseListingsPage(body), /malformed/, query);
  }
});
