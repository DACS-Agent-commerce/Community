import assert from "node:assert/strict";
import test from "node:test";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { artifactHash, buildCurrentEvidenceGraph, signedScope } from "../src/catalog/evidenceGraph.js";
import { reconcileCurrentCopies } from "../src/catalog/currentReconciliation.js";
import { deriveIdentityTier, type RecipePolicy } from "../src/catalog/identityVerification.js";
import { indexRegistration } from "../src/catalog/indexer.js";
import { deriveSellerReputation, isNeutralCancellation } from "../src/catalog/reputation.js";
import { verifyListing } from "../src/catalog/listingVerification.js";
import type { DealRecord, RegisteredDeal } from "../src/catalog/types.js";

type Obj = Record<string, unknown>;
const seeds = [11, 12].map((byte) => Uint8Array.from(Buffer.alloc(32, byte)));
const dids = seeds.map((seed) => `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`);
const locator = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;
const maps = new Map<string, Obj>();
const sign = async (raw: Obj, kind: "listing" | "agreement" | "evidence" | "rating" | "bundle" | "verify-result", signer: number, party = false) => {
  const hash = artifactHash(raw, kind);
  const prefixes = { listing: "dacs-listing:v1:", agreement: "dacs-agreement:v1:", evidence: "dacs-evidence:v1:", rating: "dacs-rating:v1:", bundle: "dacs-bundle:v1:", "verify-result": "dacs-verifyresult:v1:" };
  const value = Buffer.from(await ed25519Sign(Buffer.from(prefixes[kind] + hash), privateKeyFromSeed(seeds[signer]))).toString("hex");
  return party ? { party: dids[signer], algorithm: "ed25519", value } : { signer: dids[signer], algorithm: "ed25519", value };
};
const ref = (at: string, raw: Obj, kind: Parameters<typeof artifactHash>[1], extra: Obj = {}) => ({
  anchor: { kind: "storage-program", locator: at }, contentHash: artifactHash(raw, kind), ...extra,
});

async function vector(jobId = "job-1", offset = 0) {
  maps.clear();
  const at = (n: number) => locator(offset + n);
  const listingScope: Obj = {
    dacsVersion: "1", listingVersion: 1, listingId: "svc", requiredCapabilities: ["SR-2"],
    seller: { identity: { bundleVersion: "1", presentedBy: dids[1], presentedAt: 1, claims: [{ ref: dids[1] }], presentation: { kind: "per-claim", signatures: [] } }, displayName: "seller" },
    offering: { title: "test", description: "test service", category: "services.test", tags: [], deliverable: { kind: "attested-payload", payloadFormat: "application/json" } },
    buyerRequirement: { requirementVersion: "1", required: [], preferredPresentation: "any" },
    pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "pay-dem", parameters: { rail: "pay-dem" } }, { kind: "deliver-attested-payload" }],
    pricing: { kind: "fixed", price: { amount: "1.25", currency: "DEM", unit: "job" } }, acceptedRails: [{ railId: "pay-dem" }], terms: {}, validity: { notBefore: 1 },
  };
  // Listing verifier requires a presentation signature for the seller claim.
  const identity = (listingScope.seller as Obj).identity as Obj;
  const identityScope = { ...identity }; delete (identityScope as Obj).presentation;
  const identitySig = Buffer.from(await ed25519Sign(Buffer.from(`dacs-bundle-presentation:v1:${contentHash(identityScope)}`), privateKeyFromSeed(seeds[1]))).toString("hex");
  (identity.presentation as Obj).signatures = [{ ref: dids[1], signature: identitySig }];
  const listing: Obj = { ...listingScope, signature: await sign(listingScope, "listing", 1) }; maps.set(at(1), listing);
  const listingRef = { listingId: "svc", version: 1, contentHash: artifactHash(listing, "listing") };
  const agreementScope: Obj = { agreementVersion: "1", jobId, listingRef,
    parties: [{ role: "buyer", primaryClaim: dids[0] }, { role: "seller", primaryClaim: dids[1] }],
    terms: { price: { amount: "1.25", currency: "DEM" } } };
  const agreement: Obj = { ...agreementScope, signatures: [await sign(agreementScope, "agreement", 0, true), await sign(agreementScope, "agreement", 1, true)] }; maps.set(at(2), agreement);
  const evidenceScope: Obj = { evidenceVersion: "1", jobId, phase: "pay-dem", phaseIndex: 2, outcome: "success", paymentTxRefs: [`tx-${jobId}`], observedAt: 100 };
  const evidence: Obj = { ...evidenceScope, signature: await sign(evidenceScope, "evidence", 1) }; maps.set(at(3), evidence);
  const ratingScope: Obj = { ratingVersion: "1", jobId, rater: dids[0], target: dids[1], targetRole: "seller", value: 5, ratedAt: 110 };
  const rating: Obj = { ...ratingScope, signature: await sign(ratingScope, "rating", 0) }; maps.set(at(4), rating);
  const bundleScope: Obj = { bundleVersion: "1", jobId, outcome: "completed", listingRef,
    agreementRef: ref(at(2), agreement, "agreement"), parties: [
      { role: "buyer", bundleHash: "a".repeat(64), primaryClaim: dids[0] },
      { role: "seller", bundleHash: "b".repeat(64), primaryClaim: dids[1] },
    ],
    phaseSummary: [{ index: 2, kind: "settle", outcome: "ok" }], vetRecords: [],
    settlementEvidence: [ref(at(3), evidence, "evidence")], ratingRefs: [ref(at(4), rating, "rating")],
    recipeRegistryVersion: 1, railRegistryVersion: 1, finalisedAt: 120 };
  const signatures = [await sign(bundleScope, "bundle", 0, true), await sign(bundleScope, "bundle", 1, true)];
  const buyerBundle: Obj = { ...bundleScope, signatures, anchoredByRole: "buyer" }; maps.set(at(5), buyerBundle);
  const sellerBundle: Obj = { ...bundleScope, signatures, anchoredByRole: "seller" }; maps.set(at(6), sellerBundle);
  return {
    listing, buyerBundle, sellerBundle, agreement, rating,
    locators: { listing: at(1), agreement: at(2), evidence: at(3), rating: at(4), buyer: at(5), seller: at(6) },
  };
}

async function graphAt(at: string, listing: Obj, listingLocator: string) {
  return buildCurrentEvidenceGraph(at, {
    read: async (locatorValue) => maps.get(locatorValue) ?? null,
    resolveListing: async () => ({ locator: listingLocator, raw: listing }),
  });
}

function registeredDeal(jobId: string, buyer: string, seller: string): RegisteredDeal {
  return { jobId, rail: "pay-dem", buyerBundleRef: buyer, sellerBundleRef: seller, owners: { buyer: dids[0], seller: dids[1] } };
}

function dealRecord(
  deal: RegisteredDeal,
  reconciled: ReturnType<typeof reconcileCurrentCopies>,
): DealRecord {
  return {
    ...deal,
    signatureVerified: reconciled.authoritative.signaturesVerified,
    refsVerified: reconciled.refsVerified,
    reputationEligible: reconciled.refsVerified,
    sellerOutcome: reconciled.sellerOutcome,
    anchoredByRole: reconciled.authoritative.bundle.anchoredByRole as DealRecord["anchoredByRole"],
    bundleContentHash: reconciled.authoritative.bundleContentHash,
    finalisedAt: Number(reconciled.authoritative.bundle.finalisedAt),
    anchorTimestamp: 100,
    verifiedAt: 1,
  };
}

test("current evidence graph verifies full references and rejects cross-job ratings", async () => {
  const { listing, rating, locators } = await vector();
  assert.ok(await verifyListing(listing), "listing fixture must verify");
  const graph = await buildCurrentEvidenceGraph(locators.buyer, { read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locators.listing, raw: listing }) });
  assert.equal(graph.ok, true, graph.reason); assert.equal(graph.ratings.length, 1);
  maps.set(locators.rating, { ...rating, jobId: "replayed" });
  const replay = await buildCurrentEvidenceGraph(locators.buyer, { read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locators.listing, raw: listing }) });
  assert.equal(replay.ok, false);
});

test("current evidence graph caps attacker-controlled transitive work", async () => {
  const { listing, buyerBundle, rating, locators } = await vector();
  const scope = signedScope(buyerBundle, "bundle");
  scope.ratingRefs = Array.from({ length: 65 }, (_, index) => ({
    anchor: { kind: "storage-program", locator: locator(100 + index) },
    contentHash: artifactHash(rating, "rating"),
  }));
  const oversized = { ...scope, signatures: [await sign(scope, "bundle", 0, true), await sign(scope, "bundle", 1, true)], anchoredByRole: "buyer" };
  maps.set(locators.buyer, oversized);
  const graph = await buildCurrentEvidenceGraph(locators.buyer, { read: async (at) => maps.get(at) ?? rating,
    resolveListing: async () => ({ locator: locators.listing, raw: listing }) });
  assert.equal(graph.ok, false);
  assert.equal(graph.reason, "evidence graph exceeds size limit");
});

test("strict two-copy fixtures exclude #230 outcome and #224 phase-index divergence", async () => {
  const cleanFixture = await vector("clean-job", 0);
  const cleanDeal = registeredDeal("clean-job", cleanFixture.locators.buyer, cleanFixture.locators.seller);
  const clean = reconcileCurrentCopies(
    cleanDeal,
    dids[1],
    await graphAt(cleanFixture.locators.buyer, cleanFixture.listing, cleanFixture.locators.listing),
    await graphAt(cleanFixture.locators.seller, cleanFixture.listing, cleanFixture.locators.listing),
  );
  assert.equal(clean.buyerOk, true);
  assert.equal(clean.sellerOk, true);
  assert.equal(clean.divergent, false);
  assert.equal(clean.refsVerified, true);
  assert.equal(clean.selectedLocator, cleanFixture.locators.seller, "seller's verified copy is authoritative for seller reputation");
  const cleanRecord = dealRecord(cleanDeal, clean);

  const outcomeFixture = await vector("disputed-job", 10);
  const outcomeScope = signedScope(outcomeFixture.sellerBundle, "bundle");
  outcomeScope.outcome = "failed-counterparty";
  outcomeScope.phaseSummary = [{ index: 2, kind: "settle", outcome: "fail", errorClass: "counterparty" }];
  maps.set(outcomeFixture.locators.seller, {
    ...outcomeScope,
    signatures: [await sign(outcomeScope, "bundle", 0, true), await sign(outcomeScope, "bundle", 1, true)],
    anchoredByRole: "seller",
  });
  const outcomeDeal = registeredDeal("disputed-job", outcomeFixture.locators.buyer, outcomeFixture.locators.seller);
  const outcomeDivergence = reconcileCurrentCopies(
    outcomeDeal,
    dids[1],
    await graphAt(outcomeFixture.locators.buyer, outcomeFixture.listing, outcomeFixture.locators.listing),
    await graphAt(outcomeFixture.locators.seller, outcomeFixture.listing, outcomeFixture.locators.listing),
  );
  assert.equal(outcomeDivergence.divergent, true);
  assert.equal(outcomeDivergence.refsVerified, false, "#230 disputed job must not reach reputation");

  const indexFixture = await vector("index-set-job", 20);
  const indexScope = signedScope(indexFixture.sellerBundle, "bundle");
  indexScope.phaseSummary = [{ index: 3, kind: "settle", outcome: "ok" }];
  maps.set(indexFixture.locators.seller, {
    ...indexScope,
    signatures: [await sign(indexScope, "bundle", 0, true), await sign(indexScope, "bundle", 1, true)],
    anchoredByRole: "seller",
  });
  const indexDeal = registeredDeal("index-set-job", indexFixture.locators.buyer, indexFixture.locators.seller);
  const indexDivergence = reconcileCurrentCopies(
    indexDeal,
    dids[1],
    await graphAt(indexFixture.locators.buyer, indexFixture.listing, indexFixture.locators.listing),
    await graphAt(indexFixture.locators.seller, indexFixture.listing, indexFixture.locators.listing),
  );
  assert.equal(indexDivergence.divergent, true);
  assert.equal(indexDivergence.refsVerified, false, "#224 equal-length index-set mismatch must be excluded");

  const reputation = deriveSellerReputation([
    cleanRecord,
    dealRecord(outcomeDeal, outcomeDivergence),
    dealRecord(indexDeal, indexDivergence),
  ], 0, 200);
  assert.equal(reputation.bundleCount, 1);
  assert.equal(reputation.completionRate, 1);
  assert.deepEqual(reputation.bundleRefs?.map((item) => item.id), ["clean-job"]);
});

test("advisory skew stays unified and an invalid seller copy receipts the verified buyer locator", async () => {
  const advisoryFixture = await vector("advisory-job", 30);
  const advisoryScope = signedScope(advisoryFixture.sellerBundle, "bundle");
  advisoryScope.finalisedAt = 121;
  maps.set(advisoryFixture.locators.seller, {
    ...advisoryScope,
    signatures: [await sign(advisoryScope, "bundle", 0, true), await sign(advisoryScope, "bundle", 1, true)],
    anchoredByRole: "seller",
  });
  const advisoryDeal = registeredDeal("advisory-job", advisoryFixture.locators.buyer, advisoryFixture.locators.seller);
  const advisory = reconcileCurrentCopies(
    advisoryDeal,
    dids[1],
    await graphAt(advisoryFixture.locators.buyer, advisoryFixture.listing, advisoryFixture.locators.listing),
    await graphAt(advisoryFixture.locators.seller, advisoryFixture.listing, advisoryFixture.locators.listing),
  );
  assert.equal(advisory.divergent, false);
  assert.equal(advisory.refsVerified, true);

  const fallbackFixture = await vector("fallback-job", 40);
  maps.set(fallbackFixture.locators.seller, { ...fallbackFixture.sellerBundle, signatures: [] });
  const fallbackDeal = registeredDeal("fallback-job", fallbackFixture.locators.buyer, fallbackFixture.locators.seller);
  const fallback = reconcileCurrentCopies(
    fallbackDeal,
    dids[1],
    await graphAt(fallbackFixture.locators.buyer, fallbackFixture.listing, fallbackFixture.locators.listing),
    await graphAt(fallbackFixture.locators.seller, fallbackFixture.listing, fallbackFixture.locators.listing),
  );
  assert.equal(fallback.buyerOk, true);
  assert.equal(fallback.sellerOk, false);
  assert.equal(fallback.refsVerified, true);
  assert.equal(fallback.selectedLocator, fallbackFixture.locators.buyer);
  const reputation = deriveSellerReputation([dealRecord(fallbackDeal, fallback)], 0, 200);
  assert.equal(reputation.bundleRefs?.[0]?.anchor.locator, fallbackFixture.locators.buyer);
});

test("indexer reaches a valid current seller copy when the buyer anchor is unreadable", async () => {
  const fixture = await vector("seller-fallback-job", 80);
  maps.delete(fixture.locators.buyer);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const locatorValue = String(input).split("/").pop() ?? "";
    const data = maps.get(locatorValue);
    return new Response(JSON.stringify(data
      ? { success: true, owner: `0x${dids[1].slice(-64)}`, programName: "dacs:test", data }
      : { success: false }), {
      status: data ? 200 : 404,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const deal = registeredDeal("seller-fallback-job", fixture.locators.buyer, fixture.locators.seller);
    const record = await indexRegistration({
      primaryClaim: dids[1],
      displayName: "seller",
      listingAnchors: [fixture.locators.listing],
      deals: [deal],
    }, undefined, async () => { throw new Error("identity unavailable"); });
    assert.equal(record.deals.length, 1);
    assert.equal(record.deals[0].refsVerified, true);
    assert.equal(record.deals[0].anchoredByRole, "seller");
    assert.equal(record.reputation.bundleRefs?.[0]?.anchor.locator, fixture.locators.seller);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("indexer never retries a malformed current seller copy as legacy", async () => {
  const fixture = await vector("malformed-current-job", 120);
  maps.delete(fixture.locators.buyer);
  const sellerScope = signedScope(fixture.sellerBundle, "bundle");
  sellerScope.phaseSummary = [{ index: 2, kind: "settle", outcome: "banana" }];
  maps.set(fixture.locators.seller, {
    ...sellerScope,
    signatures: [await sign(sellerScope, "bundle", 0, true), await sign(sellerScope, "bundle", 1, true)],
    anchoredByRole: "seller",
  });
  const reads = new Map<string, number>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const locatorValue = String(input).split("/").pop() ?? "";
    reads.set(locatorValue, (reads.get(locatorValue) ?? 0) + 1);
    const data = maps.get(locatorValue);
    return new Response(JSON.stringify(data
      ? { success: true, owner: `0x${dids[1].slice(-64)}`, programName: "dacs:test", data }
      : { success: false }), {
      status: data ? 200 : 404,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const deal = registeredDeal("malformed-current-job", fixture.locators.buyer, fixture.locators.seller);
    const record = await indexRegistration({
      primaryClaim: dids[1],
      displayName: "seller",
      listingAnchors: [fixture.locators.listing],
      deals: [deal],
    }, undefined, async () => { throw new Error("identity unavailable"); });
    assert.equal(record.deals.length, 1);
    assert.equal(record.deals[0].refsVerified, false);
    assert.equal(reads.get(fixture.locators.seller), 1, "current seller bundle must not reach the legacy verifier");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("current bundle shape requires registry pins, party hashes and valid unique phase facts", async () => {
  const rejects = async (jobId: string, offset: number, mutate: (scope: Obj) => void) => {
    const fixture = await vector(jobId, offset);
    const scope = signedScope(fixture.buyerBundle, "bundle");
    mutate(scope);
    maps.set(fixture.locators.buyer, {
      ...scope,
      signatures: [await sign(scope, "bundle", 0, true), await sign(scope, "bundle", 1, true)],
      anchoredByRole: "buyer",
    });
    const graph = await graphAt(fixture.locators.buyer, fixture.listing, fixture.locators.listing);
    assert.equal(graph.ok, false);
    assert.match(graph.reason ?? "", /^invalid/);
  };
  await rejects("missing-registry-pin", 50, (scope) => { delete scope.recipeRegistryVersion; });
  await rejects("missing-party-hash", 60, (scope) => {
    const parties = scope.parties as Obj[];
    parties[0] = { ...parties[0] };
    delete parties[0].bundleHash;
  });
  await rejects("duplicate-phase-index", 70, (scope) => {
    scope.phaseSummary = [
      { index: 2, kind: "settle", outcome: "ok" },
      { index: 2, kind: "deliver", outcome: "ok" },
    ];
  });
  await rejects("invalid-phase-outcome", 90, (scope) => {
    scope.phaseSummary = [{ index: 2, kind: "settle", outcome: "banana" }];
  });
  await rejects("invalid-phase-error-class", 100, (scope) => {
    scope.phaseSummary = [{ index: 2, kind: "settle", outcome: "fail", errorClass: "banana" }];
  });
});

test("DACS-5 derives exact volume, ratings, SR-2 receipt window and transaction uniqueness", () => {
  const base: DealRecord = { jobId: "a", rail: "pay-dem", buyerBundleRef: locator(5), sellerBundleRef: locator(6), owners: { buyer: dids[0], seller: dids[1] },
    signatureVerified: true, refsVerified: true, reputationEligible: true, sellerOutcome: "completed", finalisedAt: 1, anchorTimestamp: 100,
    verifiedAt: 1, bundleContentHash: "a".repeat(64), agreementPrice: { amount: "1.25", currency: "DEM" },
    settlementTxIds: [{ id: "tx", observedAt: 10, phaseIndex: 2 }], ratings: [{ rater: dids[0], target: dids[1], targetRole: "seller", value: 5, ratedAt: 10, contentHash: "b".repeat(64) }] };
  const duplicate = { ...base, jobId: "b", bundleContentHash: "c".repeat(64), agreementPrice: { amount: "9", currency: "DEM" }, settlementTxIds: [{ id: "tx", observedAt: 20, phaseIndex: 2 }] };
  const out = deriveSellerReputation([base, duplicate], 0, 200);
  assert.deepEqual(out.observedTransactionalVolume, [{ currency: "DEM", amount: "1.25" }]);
  assert.equal(out.averageSellerRating, 5); assert.equal(out.bundleCount, 1); assert.equal(out.windowingBasis, "sr2-anchor-timestamp");
});

test("current pre-commit policy cancellations are reputation-neutral", () => {
  assert.equal(isNeutralCancellation("aborted-by-self", { claimedPolicy: "pre-commit" },
    { cancellationPolicy: "pre-commit" }, [{ kind: "negotiate-fixed-price", outcome: "ok" }]), true);
  assert.equal(isNeutralCancellation("aborted-by-self", { claimedPolicy: "pre-commit" },
    { cancellationPolicy: "pre-commit" }, [{ kind: "commit-agreement", outcome: "ok" }]), false);
});

test("identity tier requires a fresh passing version-pinned VerifyResult and its evidence", async () => {
  maps.clear(); const attested = { authority: "ok" }; maps.set(locator(8), attested);
  const resultScope: Obj = { resultVersion: "1", scheme: "lei", identifier: "123", recipeVersion: 2, method: "consensus-backed-proxy", decision: "pass", reason: "found",
    attestation: { anchor: { kind: "storage-program", locator: locator(8) }, contentHash: contentHash(attested) }, fetchedAt: 10, verifiedAt: 20, validUntil: 200 };
  const result: Obj = { ...resultScope, signature: await sign(resultScope, "verify-result", 0) }; maps.set(locator(9), result);
  const identity = { claims: [{ ref: "lei:123", verifiedBy: ref(locator(9), result, "verify-result", { recipeVersion: 2 }) }] };
  const policy: RecipePolicy = { scheme: "lei", recipeVersion: 2, methods: ["consensus-backed-proxy"], defaultMaxAgeSec: 60, availability: "live", trustedResultSigners: [dids[0]] };
  const tier = await deriveIdentityTier(identity, async () => policy, 100, async (at) => maps.get(at) ?? null);
  assert.equal(tier, "institutional");
  assert.equal(await deriveIdentityTier(identity, async () => policy, 201, async (at) => maps.get(at) ?? null), "self-declared");
});
