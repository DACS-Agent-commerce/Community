import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
// First: the store must open in a fresh directory, never the checkout's data/.
import "./fixtures/isolated-data-dir.js";
import { ed25519Sign, privateKeyFromSeed } from "@kynesyslabs/dacs/crypto";
import { artifactHash, signedScope } from "../src/catalog/evidenceGraph.js";
import { deriveAnchorAddress } from "../src/catalog/chain.js";
import { indexRegistration } from "../src/catalog/indexer.js";
import { legacyListingHash } from "../src/catalog/legacyListingHash.js";
import { recordArtifact } from "../src/catalog/store.js";
import type { Registration, RegisteredDeal } from "../src/catalog/types.js";
import { type Obj, bindingFor, dids, installAgreement, locator, maps, registeredDeal, seeds, sign, vector }
  from "./fixtures/current-evidence.js";

const [buyer, seller] = dids;
const offline = async (): Promise<never> => { throw new Error("identity unavailable"); };

/** Serve `maps` as the seller's storage programs. */
function serveStorage(t: TestContext): void {
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const data = maps.get(String(input).split("/").pop() ?? "");
    return data ? Response.json({ success: true, owner: `0x${seller.slice(-64)}`, data })
      : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
  });
}

interface ExpiryTiming { notBefore?: number; notAfter: number; agreementAnchoredAt?: number; finalisedAt: number }

/** A completed current-profile deal on a Listing with the given validity window. */
async function dealOnWindowedListing(jobId: string, offset: number, timing: ExpiryTiming): Promise<Registration> {
  const fixture = await vector(jobId, offset);
  const listingScope = signedScope(fixture.listing, "listing");
  listingScope.validity = { notBefore: timing.notBefore ?? 1, notAfter: timing.notAfter };
  fixture.listing = { ...listingScope, signature: await sign(listingScope, "listing", 1) };
  maps.set(fixture.locators.listing, fixture.listing);
  const listingRef = { listingId: "svc", version: 1, contentHash: artifactHash(fixture.listing, "listing") };
  fixture.buyerBundle = { ...fixture.buyerBundle, listingRef, finalisedAt: timing.finalisedAt };
  fixture.sellerBundle = { ...fixture.sellerBundle, listingRef, finalisedAt: timing.finalisedAt };
  await installAgreement(fixture, { ...signedScope(fixture.agreement, "agreement"), listingRef });
  recordArtifact({ locator: fixture.locators.agreement, kind: "agreement", profile: "dacs-v0.1",
    contentHash: artifactHash(fixture.agreement, "agreement"), observedAt: 1, anchorTime: timing.agreementAnchoredAt,
    data: fixture.agreement });
  const deal = registeredDeal(jobId, fixture.locators.buyer, fixture.locators.seller);
  return { primaryClaim: seller, displayName: "seller", listingAnchors: [fixture.locators.listing], deals: [deal],
    bundleBindings: [
      await bindingFor(jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
      await bindingFor(jobId, "seller", fixture.locators.seller, fixture.sellerBundle, 1),
    ] };
}

test("expired Listing history earns no verified deal, completion or volume whatever its timing claims", async (t) => {
  // rvc r2 C-1 and the four timing rounds: no Agreement anchor time or bundle
  // finalisedAt can stand in for an authenticated commitment receipt time.
  const notAfter = 100;
  t.mock.method(Date, "now", () => notAfter + 50);
  serveStorage(t);
  const cases: Array<[string, ExpiryTiming]> = [
    ["a deal finalised after expiry", { notAfter, agreementAnchoredAt: 90, finalisedAt: 120 }],
    ["a backdated finalisedAt behind a late Agreement anchor", { notAfter, agreementAnchoredAt: 120, finalisedAt: 90 }],
    ["an Agreement anchored before notBefore", { notBefore: 60, notAfter, agreementAnchoredAt: 50, finalisedAt: 90 }],
    ["an Agreement anchored inside the validity window", { notAfter, agreementAnchoredAt: 90, finalisedAt: 95 }],
    ["an Agreement anchored after expiry", { notAfter, agreementAnchoredAt: 120, finalisedAt: 130 }],
    ["an Agreement without anchor metadata", { notAfter, finalisedAt: 90 }],
  ];
  for (const [index, [label, timing]] of cases.entries()) {
    const record = await indexRegistration(await dealOnWindowedListing(`expired-${index}`, 3000 + index * 20, timing),
      undefined, offline);
    assert.deepEqual(record.listings, [], `${label}: expired terms leave discovery`);
    assert.equal(record.deals.length, 1, label);
    assert.equal(record.deals[0].refsVerified, false, label);
    assert.equal(record.deals[0].reputationEligible, false, label);
    assert.equal(record.reputation.completed, 0, label);
    assert.equal(record.reputation.bundleCount, 0, label);
    assert.deepEqual(record.reputation.observedTransactionalVolume, [], label);
  }
});

test("a Listing is still effective, and backs its deals, at its notAfter instant", async (t) => {
  const notAfter = 200;
  t.mock.method(Date, "now", () => notAfter);
  serveStorage(t);
  const record = await indexRegistration(await dealOnWindowedListing("not-after-edge", 3200,
    { notAfter, agreementAnchoredAt: 90, finalisedAt: 120 }), undefined, offline);
  assert.deepEqual(record.listings.map((listing) => [listing.listingId, listing.status]), [["svc", "active"]]);
  assert.equal(record.deals[0].refsVerified, true);
  assert.equal(record.reputation.completed, 1);
});

test("not-yet-effective Listings cannot authenticate completed deal history", async (t) => {
  t.mock.method(Date, "now", () => 1000);
  serveStorage(t);
  const registration = await dealOnWindowedListing("future-listing-job", 3240,
    { notBefore: 2000, notAfter: 3000, agreementAnchoredAt: 90, finalisedAt: 120 });
  const record = await indexRegistration(registration, undefined, offline);
  assert.deepEqual(record.listings, []);
  assert.equal(record.deals[0].refsVerified, false);
  assert.equal(record.deals[0].reputationEligible, false);
  assert.equal(record.reputation.bundleCount, 0);
  assert.equal(record.reputation.completed, 0);
  assert.equal(record.reputation.averageSellerRating, null);
  assert.deepEqual(record.reputation.observedTransactionalVolume, []);
});

// ── Legacy two-copy deals take their category from the Listing ID alone ─────

const legacySignature = (scope: Obj, prefix: string, signer: number) =>
  Buffer.from(ed25519Sign(Buffer.from(prefix + legacyListingHash(scope)), privateKeyFromSeed(seeds[signer]))).toString("base64url");

/** A signed legacy-profile Listing. */
function legacyListing(listingId: string, version: number, category: string, validity: Obj): Obj {
  const scope: Obj = { agentId: seller, serviceId: listingId, listingVersion: version, name: "Service", description: "Legacy service",
    category, claimRequirements: [], supportedNegotiation: ["negotiate-fixed-price"], supportedPaymentRails: ["pay-dem"],
    supportedDelivery: ["deliver-attested-payload"], validity };
  return { ...scope, signature: { algorithm: "ed25519", signer: seller, value: legacySignature(scope, "dacs-listing:v1:", 1) } };
}

/** Anchor a completed legacy two-copy deal on `listing` at `listingAt`, both copies signed by both parties. */
function legacyDeal(jobId: string, listing: Obj, listingAt: string, offset: number): RegisteredDeal {
  const { signature: _signature, ...listingScope } = listing;
  const agreementScope: Obj = { jobId, pattern: "fixed-price", buyer, seller, listingRef: listingAt,
    price: { amount: "1", asset: "DEM", decimals: 18, rail: "pay-dem" },
    delivery: { phase: "deliver-attested-payload", format: "application/json" }, expiresAt: "2099-01-01T00:00:00.000Z" };
  const agreement = { ...agreementScope, signatures: [0, 1].map((signer) =>
    ({ party: dids[signer], algorithm: "ed25519", value: legacySignature(agreementScope, "dacs-agreement:v1:", signer) })) };
  maps.set(deriveAnchorAddress(buyer, `dacs3:agreement:${jobId}`), agreement);
  const body: Obj = { bundleVersion: "1", jobId, outcome: "completed",
    listingRef: { listingId: listingScope.serviceId, version: listingScope.listingVersion, contentHash: legacyListingHash(listingScope) },
    agreementRef: { kind: "dacs-3-agreement", id: "agreement", contentHash: legacyListingHash(agreementScope) },
    parties: [{ role: "buyer", primaryClaim: buyer, bundleHash: "a".repeat(64) }, { role: "seller", primaryClaim: seller, bundleHash: "b".repeat(64) }],
    phaseSummary: [{ index: 0, kind: "commit-agreement", outcome: "ok" }], vetRecords: [], settlementEvidence: [],
    recipeRegistryVersion: 1, railRegistryVersion: 1, finalisedAt: 120 };
  const signatures = [0, 1].map((signer) =>
    ({ party: dids[signer], algorithm: "ed25519", value: legacySignature(body, "dacs-bundle:v1:", signer) }));
  maps.set(locator(offset), { ...body, signatures, anchoredByRole: "buyer" });
  maps.set(locator(offset + 1), { ...body, signatures, anchoredByRole: "seller" });
  return { jobId, rail: "pay-dem", buyerBundleRef: locator(offset), sellerBundleRef: locator(offset + 1), owners: { buyer, seller } };
}

test("an expired Listing gives its legacy deals no category credit on an active Listing (cold2 F1)", async (t) => {
  t.mock.method(Date, "now", () => 1000);
  serveStorage(t);
  const fixture = await vector("legacy-category-active", 3300);
  const activeScope = signedScope(fixture.listing, "listing");
  activeScope.listingId = "active-svc";
  maps.set(fixture.locators.listing, { ...activeScope, signature: await sign(activeScope, "listing", 1) });
  const expired = legacyListing("expired-svc", 1, "services.test", { notBefore: 1, notAfter: 100 });
  const expiredAt = locator(3320);
  maps.set(expiredAt, expired);
  const deal = legacyDeal("legacy-expired-job", expired, expiredAt, 3321);
  const record = await indexRegistration({ primaryClaim: seller, displayName: "seller",
    listingAnchors: [fixture.locators.listing, expiredAt], deals: [deal] }, undefined, offline);
  assert.deepEqual(record.listings.map((listing) => listing.listingId), ["active-svc"]);
  assert.equal(record.deals[0].category, undefined, "expired terms name no category");
  assert.equal(record.listings[0].reputationHint?.bundleCount, 0);
  assert.equal(record.listings[0].reputationHint?.completionRate, null);
});

test("an expired version never replaces the effective version's category, in either anchor order", async (t) => {
  t.mock.method(Date, "now", () => 1000);
  serveStorage(t);
  maps.clear();
  const expired = legacyListing("versioned-svc", 1, "services.alpha", { notBefore: 1, notAfter: 100 });
  const effective = legacyListing("versioned-svc", 2, "services.beta", { notBefore: 1 });
  const [expiredAt, effectiveAt] = [locator(3340), locator(3341)];
  maps.set(expiredAt, expired);
  maps.set(effectiveAt, effective);
  const deal = legacyDeal("legacy-effective-job", effective, effectiveAt, 3342);
  for (const listingAnchors of [[expiredAt, effectiveAt], [effectiveAt, expiredAt]]) {
    const record = await indexRegistration({ primaryClaim: seller, displayName: "seller", listingAnchors, deals: [deal] },
      undefined, offline);
    assert.deepEqual(record.listings.map((listing) => [listing.listingId, listing.version]), [["versioned-svc", 2]]);
    assert.equal(record.deals[0].refsVerified, true, "the effective version backs the deal");
    assert.equal(record.deals[0].category, "services.beta", listingAnchors.join(","));
    assert.equal(record.listings[0].reputationHint?.bundleCount, 1, listingAnchors.join(","));
  }
});
