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
const sign = async (raw: Obj, kind: "listing" | "agreement" | "evidence" | "rating" | "bundle" | "verify-result" | "composite", signer: number, party = false) => {
  const hash = artifactHash(raw, kind);
  const prefixes = { listing: "dacs-listing:v1:", agreement: "dacs-agreement:v1:", evidence: "dacs-evidence:v1:", rating: "dacs-rating:v1:", bundle: "dacs-bundle:v1:", "verify-result": "dacs-verifyresult:v1:", composite: "dacs-composite:v1:" };
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
    listing, buyerBundle, sellerBundle, agreement, evidence, rating,
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

const resignBundle = async (scope: Obj): Promise<Obj> => ({
  ...scope,
  signatures: [await sign(scope, "bundle", 0, true), await sign(scope, "bundle", 1, true)],
  anchoredByRole: "buyer",
});

test("current evidence graph verifies full references and rejects cross-job ratings", async () => {
  const { listing, buyerBundle: bundle, agreement, evidence, rating, locators } = await vector();
  assert.ok(await verifyListing(listing), "listing fixture must verify");
  const graph = await buildCurrentEvidenceGraph(locators.buyer, { read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locators.listing, raw: listing }) });
  assert.equal(graph.ok, true, graph.reason); assert.equal(graph.ratings.length, 1);
  const ratingScope = signedScope(rating, "rating");
  maps.set(locator(4), { ...ratingScope, signature: await sign(ratingScope, "rating", 1) });
  const forgedRater = await buildCurrentEvidenceGraph(locator(5), { read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(forgedRater.ok, false);

  const wrongTargetRoleScope = { ...ratingScope, targetRole: "buyer" };
  const wrongTargetRole = {
    ...wrongTargetRoleScope,
    signature: await sign(wrongTargetRoleScope, "rating", 0),
  };
  maps.set(locator(4), wrongTargetRole);
  const wrongTargetRoleBundle = signedScope(bundle, "bundle");
  wrongTargetRoleBundle.ratingRefs = [ref(locator(4), wrongTargetRole, "rating")];
  maps.set(locator(5), await resignBundle(wrongTargetRoleBundle));
  const mismatchedTargetRole = await buildCurrentEvidenceGraph(locator(5), { read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(mismatchedTargetRole.ok, false);
  maps.set(locator(4), rating);

  const linkedPhase = signedScope(bundle, "bundle");
  linkedPhase.phaseSummary = [{
    index: 2,
    kind: "settle",
    outcome: "ok",
    attestationRef: (bundle.settlementEvidence as unknown[])[0],
  }];
  maps.set(locator(5), await resignBundle(linkedPhase));
  const linked = await buildCurrentEvidenceGraph(locator(5), { read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(linked.ok, true, linked.reason);

  maps.set(locator(5), { ...bundle, signatures: [...(bundle.signatures as unknown[]), null] });
  const malformedSignature = await buildCurrentEvidenceGraph(locator(5), { read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(malformedSignature.ok, false);

  maps.set(locator(5), { ...bundle, signature: null });
  const ambiguousBundleSignature = await buildCurrentEvidenceGraph(locator(5), { read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(ambiguousBundleSignature.ok, false);

  const wrongAlgorithmSignatures = (bundle.signatures as Obj[]).map((signature, index) =>
    index === 0 ? { ...signature, algorithm: "ecdsa-secp256k1" } : signature);
  maps.set(locator(5), { ...bundle, signatures: wrongAlgorithmSignatures });
  const wrongAlgorithm = await buildCurrentEvidenceGraph(locator(5), { read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(wrongAlgorithm.ok, false);

  const missingRequiredArray = signedScope(bundle, "bundle");
  delete missingRequiredArray.settlementEvidence;
  maps.set(locator(5), await resignBundle(missingRequiredArray));
  const missingRefs = await buildCurrentEvidenceGraph(locator(5), { read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(missingRefs.ok, false);
  assert.equal(missingRefs.reason, "invalid current DACS-5 bundle shape");

  const unsupportedAmendment = signedScope(bundle, "bundle");
  unsupportedAmendment.amendments = [{}];
  maps.set(locator(5), await resignBundle(unsupportedAmendment));
  const amendment = await buildCurrentEvidenceGraph(locator(5), { read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(amendment.ok, false);
  assert.equal(amendment.reason, "invalid current DACS-5 bundle shape");

  const invalidRatingRefs = signedScope(bundle, "bundle");
  invalidRatingRefs.ratingRefs = "not-an-array";
  maps.set(locator(5), await resignBundle(invalidRatingRefs));
  const invalidRatings = await buildCurrentEvidenceGraph(locator(5), { read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(invalidRatings.ok, false);

  const duplicateTopLevel = signedScope(bundle, "bundle");
  duplicateTopLevel.ratingRefs = [
    ...(bundle.ratingRefs as unknown[]),
    (bundle.ratingRefs as unknown[])[0],
  ];
  maps.set(locator(5), await resignBundle(duplicateTopLevel));
  const duplicateRefs = await buildCurrentEvidenceGraph(locator(5), { read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(duplicateRefs.ok, true, duplicateRefs.reason);
  assert.equal(duplicateRefs.ratings.length, 1);

  const orphanedPhase = signedScope(bundle, "bundle");
  orphanedPhase.phaseSummary = [{
    index: 2,
    kind: "settle",
    outcome: "ok",
    attestationRef: {
      anchor: { kind: "storage-program", locator: locator(99) },
      contentHash: "a".repeat(64),
    },
  }];
  maps.set(locator(5), await resignBundle(orphanedPhase));
  const orphaned = await buildCurrentEvidenceGraph(locator(5), { read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(orphaned.ok, false);
  assert.equal(orphaned.reason, "phase attestation reference is outside the verified graph");

  const malformedEvidenceScope = signedScope(evidence, "evidence");
  malformedEvidenceScope.amendmentRefs = "not-an-array";
  const malformedEvidence = {
    ...malformedEvidenceScope,
    signature: await sign(malformedEvidenceScope, "evidence", 1),
  };
  maps.set(locator(3), malformedEvidence);
  const malformedEvidenceBundle = signedScope(bundle, "bundle");
  malformedEvidenceBundle.settlementEvidence = [ref(locator(3), malformedEvidence, "evidence")];
  maps.set(locator(5), await resignBundle(malformedEvidenceBundle));
  const badEvidenceRefs = await buildCurrentEvidenceGraph(locator(5), { read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(badEvidenceRefs.ok, false);

  const ambiguousEvidenceScope = signedScope(evidence, "evidence");
  ambiguousEvidenceScope.signatures = [null];
  const ambiguousEvidence = {
    ...ambiguousEvidenceScope,
    signature: await sign(ambiguousEvidenceScope, "evidence", 1),
  };
  maps.set(locator(3), ambiguousEvidence);
  const ambiguousEvidenceBundle = signedScope(bundle, "bundle");
  ambiguousEvidenceBundle.settlementEvidence = [ref(locator(3), ambiguousEvidence, "evidence")];
  maps.set(locator(5), await resignBundle(ambiguousEvidenceBundle));
  const ambiguousContainers = await buildCurrentEvidenceGraph(locator(5), { read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(ambiguousContainers.ok, false);

  const conflictingNestedScope = signedScope(evidence, "evidence");
  conflictingNestedScope.supersedesEvidenceRef = {
    anchor: { kind: "storage-program", locator: locator(3) },
    contentHash: "a".repeat(64),
  };
  const conflictingNestedEvidence = {
    ...conflictingNestedScope,
    signature: await sign(conflictingNestedScope, "evidence", 1),
  };
  maps.set(locator(3), conflictingNestedEvidence);
  const conflictingNestedBundle = signedScope(bundle, "bundle");
  conflictingNestedBundle.settlementEvidence = [ref(locator(3), conflictingNestedEvidence, "evidence")];
  maps.set(locator(5), await resignBundle(conflictingNestedBundle));
  const conflictingNested = await buildCurrentEvidenceGraph(locator(5), { read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(conflictingNested.ok, false);
  assert.equal(conflictingNested.reason, "settlement evidence chain failed");
  maps.set(locator(3), evidence);

  const malformedCompositeScope: Obj = {
    recordVersion: "1",
    jobId: "job-1",
    evaluatedParty: dids[1],
    overallDecision: "pass",
    freshness: "not-an-array",
    dealSpecific: [],
  };
  const malformedComposite = {
    ...malformedCompositeScope,
    signature: await sign(malformedCompositeScope, "composite", 0),
  };
  maps.set(locator(6), malformedComposite);
  const malformedCompositeBundle = signedScope(bundle, "bundle");
  malformedCompositeBundle.vetRecords = [ref(locator(6), malformedComposite, "composite")];
  maps.set(locator(5), await resignBundle(malformedCompositeBundle));
  const badCompositeRefs = await buildCurrentEvidenceGraph(locator(5), { read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(badCompositeRefs.ok, false);

  const crossJobAgreementScope = { ...signedScope(agreement, "agreement"), jobId: "another-job" };
  const crossJobAgreement = {
    ...crossJobAgreementScope,
    signatures: [
      await sign(crossJobAgreementScope, "agreement", 0, true),
      await sign(crossJobAgreementScope, "agreement", 1, true),
    ],
  };
  maps.set(locator(2), crossJobAgreement);
  const crossJobAgreementBundle = signedScope(bundle, "bundle");
  crossJobAgreementBundle.agreementRef = ref(locator(2), crossJobAgreement, "agreement");
  maps.set(locator(5), await resignBundle(crossJobAgreementBundle));
  const crossJob = await buildCurrentEvidenceGraph(locator(5), { read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(crossJob.ok, false);
  assert.equal(crossJob.reason, "agreement belongs to another job");

  maps.set(locator(5), bundle);
  maps.set(locator(2), { ...agreement, signatures: [...(agreement.signatures as unknown[]), null] });
  const malformedAgreementSignature = await buildCurrentEvidenceGraph(locator(5), { read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(malformedAgreementSignature.ok, false);
  maps.set(locator(2), agreement);
  maps.set(locator(4), { ...rating, jobId: "replayed" });
  const replay = await buildCurrentEvidenceGraph(locator(5), { read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(replay.ok, false);
});

test("current evidence graph accepts a verified vet record as its phase attestation", async () => {
  const { listing, buyerBundle: bundle } = await vector();
  const compositeScope: Obj = {
    recordVersion: "1",
    jobId: "job-1",
    evaluatedParty: dids[1],
    freshness: [],
    supplementary: [],
    dealSpecific: [],
    overallDecision: "pass",
  };
  const composite = {
    ...compositeScope,
    signature: await sign(compositeScope, "composite", 0),
  };
  maps.set(locator(6), composite);

  const scope = signedScope(bundle, "bundle");
  scope.vetRecords = [ref(locator(6), composite, "composite")];
  scope.phaseSummary = [{
    index: 2,
    kind: "vet-credentials",
    outcome: "ok",
    attestationRef: (scope.vetRecords as unknown[])[0],
  }];
  maps.set(locator(5), await resignBundle(scope));

  const graph = await buildCurrentEvidenceGraph(locator(5), { read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(graph.ok, true, graph.reason);
});

test("current evidence graph resolves VerifyResult authority attestations", async () => {
  const { listing, buyerBundle: bundle } = await vector();
  const attestation = { authority: "registry", status: "active" };
  maps.set(locator(7), attestation);
  const verifyResultScope: Obj = {
    resultVersion: "1",
    scheme: "lei",
    identifier: "123",
    recipeVersion: 1,
    method: "consensus-backed-proxy",
    decision: "pass",
    reason: "found",
    attestation: ref(locator(7), attestation, "attestation"),
    fetchedAt: 10,
    verifiedAt: 20,
  };
  const verifyResult = {
    ...verifyResultScope,
    signature: await sign(verifyResultScope, "verify-result", 0),
  };
  maps.set(locator(8), verifyResult);
  const compositeScope: Obj = {
    recordVersion: "1",
    jobId: "job-1",
    evaluatedParty: dids[1],
    freshness: [ref(locator(8), verifyResult, "verify-result", { recipeVersion: 1 })],
    supplementary: [],
    dealSpecific: [],
    overallDecision: "pass",
  };
  const composite = {
    ...compositeScope,
    signature: await sign(compositeScope, "composite", 0),
  };
  maps.set(locator(6), composite);
  const scope = signedScope(bundle, "bundle");
  scope.vetRecords = [ref(locator(6), composite, "composite")];
  maps.set(locator(5), await resignBundle(scope));

  const graph = await buildCurrentEvidenceGraph(locator(5), { read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(graph.ok, true, graph.reason);
  assert.equal(graph.artifacts.some((artifact) => artifact.kind === "attestation"), true);

  maps.set(locator(7), { ...attestation, status: "tampered" });
  const tampered = await buildCurrentEvidenceGraph(locator(5), { read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.reason, "VerifyResult attestation reference failed");
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

  const kindFixture = await vector("kind-substitution-job", 30);
  const kindScope = signedScope(kindFixture.sellerBundle, "bundle");
  kindScope.phaseSummary = [{ index: 2, kind: "commit-agreement", outcome: "ok" }];
  maps.set(kindFixture.locators.seller, {
    ...kindScope,
    signatures: [await sign(kindScope, "bundle", 0, true), await sign(kindScope, "bundle", 1, true)],
    anchoredByRole: "seller",
  });
  const kindDeal = registeredDeal("kind-substitution-job", kindFixture.locators.buyer, kindFixture.locators.seller);
  const kindDivergence = reconcileCurrentCopies(
    kindDeal,
    dids[1],
    await graphAt(kindFixture.locators.buyer, kindFixture.listing, kindFixture.locators.listing),
    await graphAt(kindFixture.locators.seller, kindFixture.listing, kindFixture.locators.listing),
  );
  assert.equal(kindDivergence.divergent, true);
  assert.equal(kindDivergence.refsVerified, false, "#254 same-index phase kind mismatch must be excluded");

  const reputation = deriveSellerReputation([
    cleanRecord,
    dealRecord(outcomeDeal, outcomeDivergence),
    dealRecord(indexDeal, indexDivergence),
    dealRecord(kindDeal, kindDivergence),
  ], 0, 200);
  assert.equal(reputation.bundleCount, 1);
  assert.equal(reputation.completionRate, 1);
  assert.deepEqual(reputation.bundleRefs?.map((item) => item.id), ["clean-job"]);
});

test("advisory skew stays unified and an invalid seller copy receipts the verified buyer locator", async () => {
  const advisoryFixture = await vector("advisory-job", 40);
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

  const fallbackFixture = await vector("fallback-job", 50);
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

test("DACS-5 uses one window basis and omits malformed currency aggregates", () => {
  const record = (jobId: string, values: Partial<DealRecord>): DealRecord => ({
    jobId, rail: "pay-dem", buyerBundleRef: locator(150 + Number(jobId)),
    owners: { buyer: dids[0], seller: dids[1] }, signatureVerified: true,
    refsVerified: true, reputationEligible: true, sellerOutcome: "completed",
    verifiedAt: 1, bundleContentHash: jobId.repeat(64).slice(0, 64), ...values,
  });
  const out = deriveSellerReputation([
    record("1", { anchorTimestamp: 100, finalisedAt: 300, agreementPrice: { amount: "9", currency: "DEM" } }),
    record("2", { finalisedAt: 100, agreementPrice: { amount: "1", currency: "DEM" } }),
    record("3", { finalisedAt: 100, agreementPrice: { amount: "not-a-decimal", currency: "DEM" } }),
    record("4", { finalisedAt: 100, agreementPrice: { amount: 1 as unknown as string, currency: "DEM" } }),
    record("5", { finalisedAt: 100, agreementPrice: { amount: "2.5", currency: "USDC" } }),
  ], 0, 200);

  assert.equal(out.windowingBasis, "finalisedAt");
  assert.equal(out.bundleCount, 4, "the anchor-only in-window record must be excluded on the uniform fallback basis");
  assert.deepEqual(out.observedTransactionalVolume, [{ currency: "USDC", amount: "2.5" }]);
  assert.deepEqual(out.transactionCountByCurrency, [{ currency: "USDC", count: 1 }]);
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
