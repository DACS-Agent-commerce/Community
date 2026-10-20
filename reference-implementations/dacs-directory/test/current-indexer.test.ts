import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isSettlementEvidence } from "@kynesyslabs/dacs/artifacts";
import { contentHash, paymentEvidenceAddress } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { artifactHash, buildCurrentEvidenceGraph, signedScope } from "../src/catalog/evidenceGraph.js";
import { agreementRail } from "../src/catalog/agreementMetadata.js";
import { currentBundleCopiesDiverge, reconcileCurrentCopies } from "../src/catalog/currentReconciliation.js";
import { deriveIdentityTier, type RecipePolicy } from "../src/catalog/identityVerification.js";
import {
  indexRegistration,
  listingBindingRejection,
  listingIsCurrentlyEffective,
} from "../src/catalog/indexer.js";
import { deriveSellerReputation, isNeutralCancellation } from "../src/catalog/reputation.js";
import { inCategory, isCanonicalSettlementTxId, PINNED_RAIL_HANDLERS, settlementTxId, settlementClaims, SETTLEMENT_PROJECTION_VERSION, UNPROJECTED_PINNED_RAILS } from "../src/catalog/settlementUniqueness.js";
import { projectTestnetCatalog, rebuildCatalogObservations } from "../src/catalog/testnetMetrics.js";
import { isCanonicalSettlementIdentity } from "../vendor/dacs-sdk/dist/agent/settlementIdentity.js";
import { verifyListing } from "../src/catalog/listingVerification.js";
import { boundedBundleBindings, logicalBundleAddress } from "../src/catalog/bundleBinding.js";
import { admitRevocationCandidates, loadScanState, saveScanState } from "../src/catalog/store.js";
import { registrationMessage } from "../src/catalog/registrationSig.js";
import type { BundleBinding, DealRecord, ListingSummary, RegisteredDeal, Registration, SellerRecord } from "../src/catalog/types.js";

import { type Obj, seeds, dids, locator, maps, evidenceAddresses, sign, ref, demosTxHash, vector, bindingFor,
  installAgreement, payeeBoundVector, graphAt, registeredDeal } from "./fixtures/current-evidence.js";

test("listing Gate-2 binding failures have stable rejection classes", () => {
  assert.equal(listingBindingRejection(
    dids[1],
    `0x${dids[1].slice(-64)}`,
    dids[1],
  ), null);
  assert.equal(listingBindingRejection(
    dids[0],
    `0x${dids[1].slice(-64)}`,
    dids[1],
  ), "SELLER_CLAIM_BINDING");
  assert.equal(listingBindingRejection(
    dids[1],
    `0x${dids[0].slice(-64)}`,
    dids[1],
  ), "OWNER_CLAIM_BINDING");
});

test("listing binding compares canonical §6.3.1 forms, not lowercased strings", () => {
  const owner = `0x${dids[1].slice(-64)}`;
  const hexTail = dids[1].slice(-64);
  // The `did` scheme token is case-insensitive on read (CF-2)…
  assert.equal(listingBindingRejection(`DID:${dids[1].slice(4)}`, owner, dids[1]), null);
  // …but an uppercase key is non-canonical and must not lowercase-match,
  assert.equal(
    listingBindingRejection(`did:demos:agent:${hexTail.toUpperCase()}`, owner, dids[1]),
    "SELLER_CLAIM_BINDING",
  );
  // method casing is strict,
  assert.equal(
    listingBindingRejection(`did:DEMOS:agent:${hexTail}`, owner, dids[1]),
    "SELLER_CLAIM_BINDING",
  );
  // and demos:0x… substrate-address notation is not a ClaimReference alias.
  assert.equal(
    listingBindingRejection(`demos:0x${hexTail}`, owner, dids[1]),
    "SELLER_CLAIM_BINDING",
  );
  // A registration stored in a legacy non-canonical form never binds.
  assert.equal(listingBindingRejection(dids[1], owner, `0x${hexTail}`), "SELLER_CLAIM_BINDING");
});

test("listing discovery enforces both edges of the signed validity window", () => {
  const now = 1_000;
  assert.equal(listingIsCurrentlyEffective({ validity: { notBefore: now } }, now), true);
  assert.equal(listingIsCurrentlyEffective({ validity: { notBefore: now + 1 } }, now), false);
  assert.equal(listingIsCurrentlyEffective({ validity: { notBefore: 1, notAfter: now } }, now), true);
  assert.equal(listingIsCurrentlyEffective({ validity: { notBefore: 1, notAfter: now - 1 } }, now), false);
  assert.equal(listingIsCurrentlyEffective({}, now), true, "explicit legacy Listings have no validity field");
});

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
  assert.equal(agreementRail(agreement), "demos-native:DEM");
  assert.equal(agreementRail({
    terms: { rail: { railId: "ap2:stripe-paymentintents" } },
  }), "ap2:stripe-paymentintents");
  assert.equal(agreementRail({ terms: { rail: { railId: "" } } }), null);
  assert.equal(agreementRail({ terms: { rail: "pay-dem" } }), null);
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
    jobId: "0009NBCEE23QWAN075F29Q1AEV",
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

  const crossJobAgreementScope = { ...signedScope(agreement, "agreement"), jobId: "00QFFVZB9YW36SJGJCXXGY8QFW" };
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

test("current evidence graph verifies payee-bound agreements under their distinct domain", async () => {
  const fixture = await payeeBoundVector();
  assert.ok(await verifyListing(fixture.listing), "payee-bound commitment listing must verify");
  const graph = await graphAt(fixture.locators.buyer, fixture.listing, fixture.locators.listing);
  assert.equal(graph.ok, true, graph.reason);
  assert.equal(graph.agreement?.payeeBoundAgreementVersion, "1");
  assert.equal(graph.agreement?.agreementVersion, undefined);
});

test("current evidence graph verifies v0.3 FaultAttestationBundle attribution and domain", async () => {
  const fixture = await vector("00ZQ4NGYV544V8AY5ZTKK9NWJ6", 20);
  const install = async (raw: Obj, role: "buyer" | "seller") => {
    const scope = signedScope(raw, "bundle");
    delete scope.bundleVersion;
    scope.faultBundleVersion = "1";
    scope.faultedParty = "none";
    const signatures = [await sign(scope, "bundle", 0, true), await sign(scope, "bundle", 1, true)];
    const fault = { ...scope, signatures, anchoredByRole: role };
    maps.set(role === "buyer" ? fixture.locators.buyer : fixture.locators.seller, fault);
    return fault;
  };
  const buyer = await install(fixture.buyerBundle, "buyer");
  const seller = await install(fixture.sellerBundle, "seller");
  assert.equal((await graphAt(fixture.locators.buyer, fixture.listing, fixture.locators.listing)).ok, true);
  assert.equal((await graphAt(fixture.locators.seller, fixture.listing, fixture.locators.listing)).ok, true);
  assert.equal(currentBundleCopiesDiverge(buyer, seller), false);

  const invalidScope = signedScope(buyer, "bundle");
  invalidScope.faultedParty = "buyer";
  maps.set(fixture.locators.buyer, {
    ...invalidScope,
    signatures: [await sign(invalidScope, "bundle", 0, true), await sign(invalidScope, "bundle", 1, true)],
    anchoredByRole: "buyer",
  });
  const invalid = await graphAt(fixture.locators.buyer, fixture.listing, fixture.locators.listing);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, "invalid fault attribution");
});

test("payee-bound agreements fail closed on discriminator, domain and payout coverage", async () => {
  const cases: Array<{
    name: string;
    mutate: (scope: Obj) => void;
    signaturePrefix?: string;
  }> = [
    {
      name: "both discriminators",
      mutate: (scope) => { scope.agreementVersion = "1"; },
    },
    {
      name: "unsupported extra discriminator",
      mutate: (scope) => { scope.agreementVersion = "2"; },
    },
    {
      name: "legacy signature domain",
      mutate: () => {},
      signaturePrefix: "dacs-agreement:v1:",
    },
    {
      name: "missing payout binding",
      mutate: (scope) => { (scope.terms as Obj).payoutBindings = []; },
    },
    {
      name: "wrong payout rail",
      mutate: (scope) => {
        (scope.terms as Obj).payoutBindings = [{ railId: "x402:default", phaseIndex: 2, payeeAddress: dids[1] }];
      },
    },
    {
      name: "duplicate payout key",
      mutate: (scope) => {
        const binding = { railId: "demos-native:DEM", phaseIndex: 2, payeeAddress: dids[1] };
        (scope.terms as Obj).payoutBindings = [binding, { ...binding }];
      },
    },
  ];

  for (const [index, candidate] of cases.entries()) {
    const fixture = await payeeBoundVector(`payee-bound-invalid-${index}`, 200 + index * 10);
    const scope = signedScope(fixture.agreement, "agreement");
    candidate.mutate(scope);
    await installAgreement(fixture, scope, candidate.signaturePrefix);
    const graph = await graphAt(fixture.locators.buyer, fixture.listing, fixture.locators.listing);
    assert.equal(graph.ok, false, `${candidate.name} must fail closed`);
  }

  const legacy = await vector("legacy-with-payout-binding", 300);
  const legacyScope = signedScope(legacy.agreement, "agreement");
  (legacyScope.terms as Obj).payoutBindings = [
    { railId: "demos-native:DEM", phaseIndex: 2, payeeAddress: dids[1] },
  ];
  await installAgreement(legacy, legacyScope);
  const legacyGraph = await graphAt(legacy.locators.buyer, legacy.listing, legacy.locators.listing);
  assert.equal(legacyGraph.ok, false, "legacy agreement must not acquire payee-bound semantics");

  const mismatchedCommitment = await payeeBoundVector("legacy-artifact-under-payee-commit", 320);
  const mismatchedScope = signedScope(mismatchedCommitment.agreement, "agreement");
  delete mismatchedScope.payeeBoundAgreementVersion;
  mismatchedScope.agreementVersion = "1";
  delete (mismatchedScope.terms as Obj).payoutBindings;
  await installAgreement(mismatchedCommitment, mismatchedScope);
  const mismatchedGraph = await graphAt(
    mismatchedCommitment.locators.buyer,
    mismatchedCommitment.listing,
    mismatchedCommitment.locators.listing,
  );
  assert.equal(mismatchedGraph.ok, false, "agreement artifact type must match the listing commitment phase");
});

test("current evidence graph accepts a verified vet record as its phase attestation", async () => {
  const { listing, buyerBundle: bundle } = await vector();
  const compositeScope: Obj = {
    recordVersion: "1",
    jobId: "0009NBCEE23QWAN075F29Q1AEV",
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
    jobId: "0009NBCEE23QWAN075F29Q1AEV",
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
  const cleanFixture = await vector("00YGXGZFGRHE1C38YH38B44ZFX", 0);
  const cleanDeal = registeredDeal("00YGXGZFGRHE1C38YH38B44ZFX", cleanFixture.locators.buyer, cleanFixture.locators.seller);
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

  const outcomeFixture = await vector("00F4DME5WZNBKWZZ9S570ZF4BT", 10);
  const outcomeScope = signedScope(outcomeFixture.sellerBundle, "bundle");
  outcomeScope.outcome = "failed-counterparty";
  outcomeScope.phaseSummary = [{ index: 2, kind: "settle", outcome: "fail", errorClass: "counterparty" }];
  maps.set(outcomeFixture.locators.seller, {
    ...outcomeScope,
    signatures: [await sign(outcomeScope, "bundle", 0, true), await sign(outcomeScope, "bundle", 1, true)],
    anchoredByRole: "seller",
  });
  const outcomeDeal = registeredDeal("00F4DME5WZNBKWZZ9S570ZF4BT", outcomeFixture.locators.buyer, outcomeFixture.locators.seller);
  const outcomeDivergence = reconcileCurrentCopies(
    outcomeDeal,
    dids[1],
    await graphAt(outcomeFixture.locators.buyer, outcomeFixture.listing, outcomeFixture.locators.listing),
    await graphAt(outcomeFixture.locators.seller, outcomeFixture.listing, outcomeFixture.locators.listing),
  );
  assert.equal(outcomeDivergence.divergent, true);
  assert.equal(outcomeDivergence.refsVerified, false, "#230 disputed job must not reach reputation");

  const indexFixture = await vector("00KBZZ61NRC8Q22VFDWR5EAC4P", 20);
  const indexScope = signedScope(indexFixture.sellerBundle, "bundle");
  indexScope.phaseSummary = [{ index: 3, kind: "settle", outcome: "ok" }];
  maps.set(indexFixture.locators.seller, {
    ...indexScope,
    signatures: [await sign(indexScope, "bundle", 0, true), await sign(indexScope, "bundle", 1, true)],
    anchoredByRole: "seller",
  });
  const indexDeal = registeredDeal("00KBZZ61NRC8Q22VFDWR5EAC4P", indexFixture.locators.buyer, indexFixture.locators.seller);
  const indexDivergence = reconcileCurrentCopies(
    indexDeal,
    dids[1],
    await graphAt(indexFixture.locators.buyer, indexFixture.listing, indexFixture.locators.listing),
    await graphAt(indexFixture.locators.seller, indexFixture.listing, indexFixture.locators.listing),
  );
  assert.equal(indexDivergence.divergent, true);
  assert.equal(indexDivergence.refsVerified, false, "#224 equal-length index-set mismatch must be excluded");

  const kindFixture = await vector("00V0942PNM8XGE67DHF1B47XN6", 30);
  const kindScope = signedScope(kindFixture.sellerBundle, "bundle");
  kindScope.phaseSummary = [{ index: 2, kind: "commit-agreement", outcome: "ok" }];
  maps.set(kindFixture.locators.seller, {
    ...kindScope,
    signatures: [await sign(kindScope, "bundle", 0, true), await sign(kindScope, "bundle", 1, true)],
    anchoredByRole: "seller",
  });
  const kindDeal = registeredDeal("00V0942PNM8XGE67DHF1B47XN6", kindFixture.locators.buyer, kindFixture.locators.seller);
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
  assert.equal(reputation.completionRate, null);
  assert.deepEqual(reputation.bundleRefs?.map((item) => item.id), ["00YGXGZFGRHE1C38YH38B44ZFX"]);
});

test("advisory skew stays unified and an invalid seller copy receipts the verified buyer locator", async () => {
  const advisoryFixture = await vector("00ZGAE9GMXAW4F3G27E0A3V1GG", 40);
  const advisoryScope = signedScope(advisoryFixture.sellerBundle, "bundle");
  advisoryScope.finalisedAt = 121;
  maps.set(advisoryFixture.locators.seller, {
    ...advisoryScope,
    signatures: [await sign(advisoryScope, "bundle", 0, true), await sign(advisoryScope, "bundle", 1, true)],
    anchoredByRole: "seller",
  });
  const advisoryDeal = registeredDeal("00ZGAE9GMXAW4F3G27E0A3V1GG", advisoryFixture.locators.buyer, advisoryFixture.locators.seller);
  const advisory = reconcileCurrentCopies(
    advisoryDeal,
    dids[1],
    await graphAt(advisoryFixture.locators.buyer, advisoryFixture.listing, advisoryFixture.locators.listing),
    await graphAt(advisoryFixture.locators.seller, advisoryFixture.listing, advisoryFixture.locators.listing),
  );
  assert.equal(advisory.divergent, false);
  assert.equal(advisory.refsVerified, true);

  const fallbackFixture = await vector("00QQF4C8AFB58YC9EWEGMQVSTV", 50);
  maps.set(fallbackFixture.locators.seller, { ...fallbackFixture.sellerBundle, signatures: [] });
  const fallbackDeal = registeredDeal("00QQF4C8AFB58YC9EWEGMQVSTV", fallbackFixture.locators.buyer, fallbackFixture.locators.seller);
  const fallback = reconcileCurrentCopies(
    fallbackDeal,
    dids[1],
    await graphAt(fallbackFixture.locators.buyer, fallbackFixture.listing, fallbackFixture.locators.listing),
    await graphAt(fallbackFixture.locators.seller, fallbackFixture.listing, fallbackFixture.locators.listing),
  );
  assert.equal(fallback.buyerOk, true);
  assert.equal(fallback.sellerOk, false);
  assert.equal(fallback.refsVerified, false, "#255 requires authoritative absence before one-copy attribution");
  assert.equal(fallback.selectedLocator, fallbackFixture.locators.buyer);
  const reputation = deriveSellerReputation([dealRecord(fallbackDeal, fallback)], 0, 200);
  assert.equal(reputation.bundleCount, 0);
  assert.deepEqual(reputation.bundleRefs, []);
});

test("indexer resolves current copies through BundleBindings rather than submitted native pointers", async () => {
  const fixture = await vector("00JSH15PNV9SR0N4KGHQZHTT70", 70);
  const submittedBuyerPointer = locator(998);
  const submittedSellerPointer = locator(999);
  const deal = registeredDeal("00JSH15PNV9SR0N4KGHQZHTT70", submittedBuyerPointer, submittedSellerPointer);
  const bundleBindings = [
    await bindingFor(deal.jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
    await bindingFor(deal.jobId, "seller", fixture.locators.seller, fixture.sellerBundle, 1),
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const locatorValue = String(input).split("/").pop() ?? "";
    const data = maps.get(locatorValue);
    return new Response(JSON.stringify(data
      ? { success: true, owner: `0x${dids[1].slice(-64)}`, programName: "dacs:test", metadata: { logicalAddress: evidenceAddresses.get(String(input).split("/").pop() ?? "") }, data }
      : { success: false }), {
      status: data ? 200 : 404,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const record = await indexRegistration({
      primaryClaim: dids[1],
      displayName: "seller",
      listingAnchors: [fixture.locators.listing],
      deals: [deal],
      bundleBindings,
    }, undefined, async () => { throw new Error("identity unavailable"); });
    assert.equal(record.deals[0].refsVerified, true);
    assert.equal(record.deals[0].buyerBundleRef, fixture.locators.buyer);
    assert.notEqual(record.deals[0].buyerBundleRef, submittedBuyerPointer);
    assert.equal(record.deals[0].sellerBundleRef, fixture.locators.seller);
    assert.notEqual(record.deals[0].sellerBundleRef, submittedSellerPointer);
    assert.equal(record.deals[0].rail, "demos-native:DEM");
    assert.equal(record.reputation.bundleCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bindings signed by other parties leave a deal's binding resolution intact", async () => {
  const fixture = await vector("00BKMT9R04TRF54JT8M4CZ48V7", 90);
  const deal = registeredDeal("00BKMT9R04TRF54JT8M4CZ48V7", locator(996), locator(997));
  const holders = [
    await bindingFor(deal.jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
    await bindingFor(deal.jobId, "seller", fixture.locators.seller, fixture.sellerBundle, 1),
  ];
  const others = await Promise.all(Array.from({ length: 33 }, async (_, index) => {
    const seed = Uint8Array.from(Buffer.alloc(32, 150 + index));
    const claim = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
    const scope = { bindingVersion: "1" as const, jobId: deal.jobId, role: "buyer" as const, logicalAddress: logicalBundleAddress(deal.jobId, "buyer"),
      nativeAddress: locator(400 + index), bundleContentHash: "b".repeat(64), signer: claim };
    const value = Buffer.from(await ed25519Sign(Buffer.from(`dacs-bundle-binding:v1:${contentHash(scope)}`), privateKeyFromSeed(seed))).toString("base64url");
    return { ...scope, signature: { algorithm: "ed25519" as const, signer: claim, value } };
  }));
  // Discovered bindings and their overflow, as a reindex pass would persist them, plus another
  // signer's binding whose signature does not verify.
  const discovered = boundedBundleBindings([...others, ...holders]);
  const forged = { ...others[0], nativeAddress: locator(399) };
  const saved = loadScanState();
  saveScanState({ ...saved, bundleBindings: { ...saved.bundleBindings, [deal.jobId]: [...discovered.bindings, forged] },
    bundleBindingOverflow: [...saved.bundleBindingOverflow, ...discovered.overflowKeys] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const data = maps.get(String(input).split("/").pop() ?? "");
    return new Response(JSON.stringify(data ? { success: true, owner: `0x${dids[1].slice(-64)}`, programName: "dacs:test", metadata: { logicalAddress: evidenceAddresses.get(String(input).split("/").pop() ?? "") }, data } : { success: false }),
      { status: data ? 200 : 404, headers: { "content-type": "application/json" } });
  };
  let omitted = 0;
  const index = () => indexRegistration({ primaryClaim: dids[1], displayName: "seller", listingAnchors: [fixture.locators.listing], deals: [deal] },
    undefined, async () => { throw new Error("identity unavailable"); }, undefined, (kind, count) => { if (kind === "bindings") omitted += count; });
  try {
    const record = await index();
    assert.equal(record.deals[0].refsVerified, true);
    assert.equal(record.deals[0].buyerBundleRef, fixture.locators.buyer);
    assert.equal(omitted, 0, "other signers' bindings are not verified for this deal");
    // Overflow of the role holder's own bindings still makes its side indeterminate.
    const own = boundedBundleBindings([holders[0], await bindingFor(deal.jobId, "buyer", locator(995), fixture.buyerBundle, 0)], 1);
    saveScanState({ ...loadScanState(), bundleBindingOverflow: own.overflowKeys });
    assert.equal((await index()).deals[0].refsVerified, false);
  } finally {
    globalThis.fetch = originalFetch;
    saveScanState(saved);
  }
});

test("indexer excludes a valid current seller copy when the buyer anchor is unreadable", async () => {
  const fixture = await vector("00BN4YX701SACZCD8S19S07NAJ", 80);
  maps.delete(fixture.locators.buyer);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const locatorValue = String(input).split("/").pop() ?? "";
    const data = maps.get(locatorValue);
    return new Response(JSON.stringify(data
      ? { success: true, owner: `0x${dids[1].slice(-64)}`, programName: "dacs:test", metadata: { logicalAddress: evidenceAddresses.get(String(input).split("/").pop() ?? "") }, data }
      : { success: false }), {
      status: data ? 200 : 404,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const deal = {
      ...registeredDeal("00BN4YX701SACZCD8S19S07NAJ", fixture.locators.buyer, fixture.locators.seller),
      rail: "unknown",
    };
    const bundleBindings = [
      await bindingFor(deal.jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
      await bindingFor(deal.jobId, "seller", fixture.locators.seller, fixture.sellerBundle, 1),
    ];
    const record = await indexRegistration({
      primaryClaim: dids[1],
      displayName: "seller",
      listingAnchors: [fixture.locators.listing],
      deals: [deal],
      bundleBindings,
    }, undefined, async () => { throw new Error("identity unavailable"); });
    assert.equal(record.deals.length, 1);
    assert.equal(record.deals[0].refsVerified, false);
    assert.equal(record.deals[0].anchoredByRole, undefined, "an unresolved side makes the lookup indeterminate");
    assert.equal(record.deals[0].rail, "unknown");
    assert.equal(record.reputation.bundleCount, 0);
    assert.deepEqual(record.reputation.bundleRefs, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("indexer never retries a malformed current seller copy as legacy", async () => {
  const fixture = await vector("000QER4J53BASDB033QD6S39BK", 120);
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
      ? { success: true, owner: `0x${dids[1].slice(-64)}`, programName: "dacs:test", metadata: { logicalAddress: evidenceAddresses.get(String(input).split("/").pop() ?? "") }, data }
      : { success: false }), {
      status: data ? 200 : 404,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const deal = registeredDeal("000QER4J53BASDB033QD6S39BK", fixture.locators.buyer, fixture.locators.seller);
    const bundleBindings = [
      await bindingFor(deal.jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
      await bindingFor(deal.jobId, "seller", fixture.locators.seller, maps.get(fixture.locators.seller)!, 1),
    ];
    const record = await indexRegistration({
      primaryClaim: dids[1],
      displayName: "seller",
      listingAnchors: [fixture.locators.listing],
      deals: [deal],
      bundleBindings,
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

test("DACS-5 keeps exact volume and SR-2 window and voids SB-2 settlement collisions with testnet ratings unavailable", () => {
  const tx = `demos:${"12".repeat(32)}`;
  const base: DealRecord = { jobId: "a", rail: "pay-dem", buyerBundleRef: locator(5), sellerBundleRef: locator(6), owners: { buyer: dids[0], seller: dids[1] },
    signatureVerified: true, refsVerified: true, reputationEligible: true, sellerOutcome: "completed", finalisedAt: 1, anchorTimestamp: 100,
    verifiedAt: 1, bundleContentHash: "a".repeat(64), agreementPrice: { amount: "1.25", currency: "DEM" },
    settlementTxIds: [{ id: tx, observedAt: 10, phaseIndex: 2 }], ratings: [{ rater: dids[0], target: dids[1], targetRole: "seller", value: 5, ratedAt: 10, contentHash: "b".repeat(64) }] };
  const duplicate = { ...base, jobId: "b", bundleContentHash: "c".repeat(64), agreementPrice: { amount: "9", currency: "DEM" }, settlementTxIds: [{ id: tx, observedAt: 20, phaseIndex: 2 }] };
  const unrelated = { ...base, jobId: "c", bundleContentHash: "d".repeat(64), agreementPrice: { amount: "2", currency: "DEM" }, settlementTxIds: [{ id: `demos:${"34".repeat(32)}`, observedAt: 30, phaseIndex: 2 }] };
  // SB-2(2): no settlement-side binding authority, so the whole collision group is void.
  const out = deriveSellerReputation([base, duplicate, unrelated], 0, 200);
  assert.deepEqual(out.observedTransactionalVolume, [{ currency: "DEM", amount: "2" }]);
  assert.deepEqual(out.bundleRefs?.map((ref) => ref.id), ["c"]);
  assert.equal(out.averageSellerRating, null); assert.equal(out.bundleCount, 1); assert.equal(out.windowingBasis, "sr2-anchor-timestamp");
  // Repeating one (jobId, phaseIndex) claim is idempotent and still counts once.
  const repeated = deriveSellerReputation([{ ...base, settlementTxIds: [base.settlementTxIds![0], { id: tx, observedAt: 11, phaseIndex: 2 }] }], 0, 200);
  assert.equal(repeated.bundleCount, 1);
  assert.deepEqual(repeated.observedTransactionalVolume, [{ currency: "DEM", amount: "1.25" }]);
  // One job claiming the settlement for two phases is a collision too.
  const twoPhases = deriveSellerReputation([{ ...base, settlementTxIds: [base.settlementTxIds![0], { id: tx, observedAt: 10, phaseIndex: 3 }] }], 0, 200);
  assert.equal(twoPhases.bundleCount, 0);
  // A stored id in any spelling but the exact SB-1 one is not an SB-1 id:
  // its deal neither counts nor voids the canonical claim.
  const hash = "ab".repeat(32);
  for (const id of [`demos:0x${hash}`, `demos:${hash.toUpperCase()}`, `evm:8453:${hash.toUpperCase()}:0`, `evm:08453:${hash}:0`,
    ` demos:${hash}`, "tx", "", `solana:mainnet:${"1".repeat(63)}:0`]) {
    const spelled = deriveSellerReputation([
      { ...base, settlementTxIds: [{ id: `demos:${hash}`, observedAt: 10, phaseIndex: 2 }] },
      { ...duplicate, settlementTxIds: [{ id, observedAt: 20, phaseIndex: 2 }] },
    ], 0, 200);
    assert.deepEqual(spelled.bundleRefs?.map((ref) => ref.id), ["a"], JSON.stringify(id));
  }
  // A Solana Base58 signature is case-sensitive: two signatures that differ
  // only in letter case are distinct settlements and both count.
  const lower = `solana:mainnet:${"f".repeat(87)}:0`;
  const mixed = `solana:mainnet:${"F".repeat(64)}${"f".repeat(23)}:0`;
  assert.ok(isCanonicalSettlementIdentity(lower) && isCanonicalSettlementIdentity(mixed));
  const cased = deriveSellerReputation([
    { ...base, settlementTxIds: [{ id: lower, observedAt: 10, phaseIndex: 2 }] },
    { ...duplicate, settlementTxIds: [{ id: mixed, observedAt: 20, phaseIndex: 2 }] },
  ], 0, 200);
  assert.deepEqual(cased.bundleRefs?.map((ref) => ref.id), ["a", "b"]);
  assert.deepEqual(cased.observedTransactionalVolume, [{ currency: "DEM", amount: "10.25" }]);
  // Two buyers' deals may share a jobId (dedupe keeps both); one settlement under both is a collision.
  const otherBuyer = { ...base, buyerBundleRef: locator(7), owners: { ...base.owners, buyer: `did:demos:agent:${"e".repeat(64)}` }, bundleContentHash: "e".repeat(64) };
  assert.equal(deriveSellerReputation([base, otherBuyer], 0, 200).bundleCount, 0);
  // The complete presented set is grouped before the window: a partner outside it still voids the group.
  const late = { ...duplicate, anchorTimestamp: 300 };
  assert.equal(deriveSellerReputation([base, late], 0, 200).bundleCount, 0);
  assert.equal(deriveSellerReputation([base, { ...late, settlementTxIds: unrelated.settlementTxIds }], 0, 200).bundleCount, 1);
});

test("SB-1 projects each signed TxRef arm to the pinned settlement-tx-id and refuses what it cannot project", () => {
  const hash = "ab".repeat(32);
  const signature = "99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3BbeqPevr5E1iCbpTjqHuTFLtfxTTD5ekfVuZFzQyEQf8";
  const projected: Array<[unknown, string]> = [
    [{ kind: "demos", txHash: hash, blockNumber: 7 }, `demos:${hash}`],
    [{ kind: "demos", txHash: `0x${hash.toUpperCase()}` }, `demos:${hash}`],
    [{ kind: "settlement", rail: "demos", txHash: hash }, `demos:${hash}`],
    [{ kind: "evm-event", chainId: 8453, txHash: hash, logIndex: 3 }, `evm:8453:${hash}:3`],
    [{ kind: "x402-event", httpResource: "https://seller.example/r", paymentReceiptHash: "cd".repeat(32), settlementTxHash: hash, chainId: 8453, logIndex: 0, protocolVersion: "2" }, `evm:8453:${hash}:0`],
    [{ kind: "solana-instruction", cluster: "devnet", signature, instructionIndex: 1 }, `solana:devnet:${signature}:1`],
    [{ kind: "solana-instruction", cluster: "testnet", signature, instructionIndex: 0 }, `solana:testnet:${signature}:0`],
  ];
  for (const [ref, id] of projected) {
    assert.equal(settlementTxId(ref), id, JSON.stringify(ref));
    assert.ok(isCanonicalSettlementIdentity(id), `the pinned SDK accepts ${id}`);
    assert.ok(isCanonicalSettlementTxId(id), `the stored-id check accepts ${id}`);
  }
  // The stored-id check SB-2 admits by agrees with the pinned SDK's.
  for (const id of [
    `demos:0x${hash}`, `demos:${hash.toUpperCase()}`, `demos:${hash}0`, ` demos:${hash}`, `demos:${hash}\n`,
    `evm:0:${hash}:0`, `evm:01:${hash}:0`, `evm:1:${hash}:01`, `evm:9007199254740992:${hash}:0`, `evm:1:${hash.toUpperCase()}:0`,
    `solana:localnet:${signature}:0`, `solana:mainnet:${signature}:01`, `solana:mainnet:${"1".repeat(63)}:0`,
    `solana:mainnet:${"1".repeat(65)}:0`, `solana:mainnet:0${signature.slice(1)}:0`, `solana:mainnet:${signature}`,
    `solana:mainnet:${"f".repeat(87)}:0`, `solana:mainnet:${"F".repeat(64)}${"f".repeat(23)}:0`, `solana:mainnet:${"1".repeat(64)}:0`,
    "tx", "", `x402:${hash}`,
  ]) assert.equal(isCanonicalSettlementTxId(id), isCanonicalSettlementIdentity(id), JSON.stringify(id));
  for (const value of [null, 7, { id: `demos:${hash}` }]) assert.equal(isCanonicalSettlementTxId(value), false);
  for (const ref of [
    { kind: "demos", txHash: hash, blockNumber: -1 },
    { kind: "demos", txHash: hash, extra: true },
    { kind: "evm-event", chainId: 1, txHash: hash, logIndex: 0, extra: true },
    { kind: "x402-event", chainId: 1, settlementTxHash: hash, logIndex: 0 },
    { kind: "bogus", rail: "demos", txHash: hash },
    null, "tx-job", `demos:${hash}`, { txId: hash }, { id: hash },
    { kind: "evm", chainId: 1, txHash: hash }, { kind: "solana", cluster: "devnet", signature },
    { kind: "x402", httpResource: "https://seller.example/r", paymentReceiptHash: "cd".repeat(32), protocolVersion: "2" },
    { kind: "settlement", rail: "evm", txHash: hash }, { kind: "settlement", rail: "demos", txHash: "8e4b72" },
    { kind: "demos", txHash: "short" }, { kind: "evm-event", chainId: 0, txHash: hash, logIndex: 3 },
    { kind: "evm-event", chainId: 1, txHash: `0x${hash}`, logIndex: 3 }, { kind: "evm-event", chainId: 1, txHash: hash, logIndex: -1 },
    { kind: "evm-event", chainId: 1, txHash: hash, logIndex: 1.5 },
    { kind: "solana-instruction", cluster: "devnet", signature: "0OIl", instructionIndex: 1 },
    { kind: "solana-instruction", cluster: "localnet", signature, instructionIndex: 1 },
    { kind: "ap2", mandateId: "m", providerRef: "p", protocolVersion: "1" },
    { kind: "htlc-claim", chainId: 1, contractAddress: "0x1", claimTxHash: hash },
  ]) assert.equal(settlementTxId(ref), null, JSON.stringify(ref));
});

/** Index one seller's two verified jobs whose settlement evidence cites the given refs. */
async function indexTwoJobs(refsA: unknown[], refsB: unknown[], rail = "pay-dem", evidencePhase = rail, phaseIndex = 2) {
  const a = await vector("00XF8J44TWQZHSE3REYKBEKRA9", 1000, refsA, rail, evidencePhase, phaseIndex);
  const first = new Map(maps);
  const b = await vector("00RMM3D7M9Q2VC68EPBNNKEX3X", 2000, refsB, rail);
  for (const [at, raw] of first) maps.set(at, raw);
  return indexFixture(b, {
    deals: [registeredDeal("00XF8J44TWQZHSE3REYKBEKRA9", a.locators.buyer, a.locators.seller), registeredDeal("00RMM3D7M9Q2VC68EPBNNKEX3X", b.locators.buyer, b.locators.seller)],
    bundleBindings: [
      await bindingFor("00XF8J44TWQZHSE3REYKBEKRA9", "buyer", a.locators.buyer, a.buyerBundle, 0),
      await bindingFor("00XF8J44TWQZHSE3REYKBEKRA9", "seller", a.locators.seller, a.sellerBundle, 1),
      await bindingFor("00RMM3D7M9Q2VC68EPBNNKEX3X", "buyer", b.locators.buyer, b.buyerBundle, 0),
      await bindingFor("00RMM3D7M9Q2VC68EPBNNKEX3X", "seller", b.locators.seller, b.sellerBundle, 1),
    ],
  });
}

test("SB-2 voids one settlement cited by two verified jobs in every TxRef shape, in seller reputation and listing hints alike", async () => {
  const hash = "ab".repeat(32);
  const cases: Array<[string, unknown, unknown, string]> = [
    ["DACS-4 demos arm", { kind: "demos", txHash: hash, blockNumber: 7 }, { kind: "demos", txHash: hash, blockNumber: 8 }, `demos:${hash}`],
    ["evm-event", { kind: "evm-event", chainId: 8453, txHash: hash, logIndex: 4 }, { kind: "evm-event", chainId: 8453, txHash: hash, logIndex: 4 }, `evm:8453:${hash}:4`],
  ];
  const x402 = { kind: "x402-event", chainId: 8453, settlementTxHash: hash, logIndex: 4,
    httpResource: "https://seller.example/pay", paymentReceiptHash: "cd".repeat(32), protocolVersion: "2" };
  // The fixture's Solana rail is `solana-spl:mainnet:USDC`, so its TxRef is on mainnet.
  const solana = { kind: "solana-instruction", cluster: "mainnet", instructionIndex: 1,
    signature: "99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3BbeqPevr5E1iCbpTjqHuTFLtfxTTD5ekfVuZFzQyEQf8" };
  cases.push(["x402-event", x402, x402, `evm:8453:${hash}:4`]);
  cases.push(["solana-instruction", solana, solana, `solana:mainnet:${solana.signature}:1`]);
  const rails: Record<string, string> = {
    "evm-event": "pay-evm-erc20", "x402-event": "pay-x402", "solana-instruction": "pay-solana-spl",
  };
  for (const [name, refA, refB, id] of cases) {
    const record = await indexTwoJobs([refA], [refB], rails[name] ?? "pay-dem");
    assert.deepEqual(record.deals.map((deal) => deal.settlementProjectionVersion), [SETTLEMENT_PROJECTION_VERSION, SETTLEMENT_PROJECTION_VERSION]);
    assert.deepEqual(record.deals.map((deal) => [deal.refsVerified, deal.reputationEligible]), [[true, true], [true, true]], name);
    assert.deepEqual(record.deals.map((deal) => deal.settlementTxIds?.map((tx) => tx.id)), [[id], [id]], name);
    assert.equal(record.reputation.bundleCount, 0, name);
    assert.deepEqual(record.reputation.observedTransactionalVolume, [], name);
    assert.equal(record.listings[0].reputationHint!.bundleCount, 0, `${name}: the listing hint excludes the collision too`);
  }
  // Distinct events of one batched transaction remain distinct settlements.
  const batched = await indexTwoJobs([{ kind: "evm-event", chainId: 8453, txHash: hash, logIndex: 4 }], [{ kind: "evm-event", chainId: 8453, txHash: hash, logIndex: 5 }], "pay-evm-erc20");
  assert.equal(batched.reputation.bundleCount, 2);
  assert.equal(batched.listings[0].reputationHint!.bundleCount, 2);
  // Base58 is case-sensitive: signatures that differ only in letter case
  // (each decodes to 64 bytes) are two settlements, in every projection.
  const solanaRef = (signature: string) => ({ kind: "solana-instruction", cluster: "mainnet", signature, instructionIndex: 0 });
  const cased = await indexTwoJobs([solanaRef("f".repeat(87))], [solanaRef(`${"F".repeat(64)}${"f".repeat(23)}`)], "pay-solana-spl");
  assert.deepEqual(cased.deals.map((deal) => deal.reputationEligible), [true, true]);
  for (const result of [cased, rebuildCatalogObservations({ catalogVersion: "1", generatedAt: 10_000, sellers: [cased] }).sellers[0],
    projectTestnetCatalog({ catalogVersion: "1", generatedAt: 10_000, sellers: [cased] }).sellers[0]]) {
    assert.equal(result.reputation.bundleCount, 2);
    assert.equal(result.reputation.completed, 2);
    assert.deepEqual(result.reputation.bundleRefs?.map((ref) => ref.id).sort(), ["00RMM3D7M9Q2VC68EPBNNKEX3X", "00XF8J44TWQZHSE3REYKBEKRA9"]);
    assert.deepEqual(result.reputation.transactionCountByCurrency, [{ currency: "DEM", count: 2 }]);
    assert.equal(result.listings[0].reputationHint!.bundleCount, 2);
  }
});

test("a deal whose settlement evidence cites a TxRef SB-1 cannot project here is not counted", async () => {
  const hash = "ab".repeat(32);
  for (const [name, ref] of [
    ["bare string", "tx-unprojectable"],
    ["legacy evm arm needs ledger data", { kind: "evm", chainId: 1, txHash: hash }],
    ["legacy flat Demos evidence is history only", { kind: "settlement", rail: "demos", txHash: hash }],
    ["legacy non-Demos rail", { kind: "settlement", rail: "evm", txHash: hash }],
    ["id field only", { id: `demos:${hash}` }],
  ] as const) {
    const record = await indexTwoJobs([{ kind: "demos", txHash: hash }, ref], [{ kind: "demos", txHash: demosTxHash("other") }]);
    const [unprojectable, counted] = record.deals;
    assert.equal(unprojectable.refsVerified, true, name);
    assert.equal(unprojectable.reputationEligible, false, name);
    assert.equal(counted.reputationEligible, true, name);
    assert.equal(record.reputation.bundleCount, 1, name);
    assert.equal(record.listings[0].reputationHint!.bundleCount, 1, name);
  }
});

test("success payment claims require nonempty exact TxRefs matching the signed agreement and payment phase", async (t) => {
  const hash = "ab".repeat(32);
  const evm = { kind: "evm-event", chainId: 8453, txHash: hash, logIndex: 0 };
  const demos = { kind: "demos", txHash: hash };
  // The fixture rails are `evm-erc20:8453:USDC` and `solana-spl:mainnet:USDC`.
  const solana = { kind: "solana-instruction", cluster: "mainnet", instructionIndex: 1,
    signature: "99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3BbeqPevr5E1iCbpTjqHuTFLtfxTTD5ekfVuZFzQyEQf8" };
  const cases: Array<[string, unknown[], string, string, number?]> = [
    ["empty payment refs", [], "pay-dem", "pay-dem"],
    ["non-array payment refs", null as unknown as unknown[], "pay-dem", "pay-dem"],
    ["delivery evidence in payment phase", [], "pay-dem", "deliver-attested-payload"],
    ["wrong anchor phase index", [demos], "pay-dem", "pay-dem", 1],
    ["EVM ref under Demos agreement", [evm], "pay-dem", "pay-dem"],
    ["Demos ref under EVM agreement", [demos], "pay-evm-erc20", "pay-evm-erc20"],
    ["evidence phase differs from agreement", [evm], "pay-evm-erc20", "pay-dem"],
    ["unknown nested field", [{ ...demos, extra: true }], "pay-dem", "pay-dem"],
    ["invalid optional field", [{ ...demos, blockNumber: -1 }], "pay-dem", "pay-dem"],
    ["missing x402 receipt fields", [{ kind: "x402-event", chainId: 8453, settlementTxHash: hash, logIndex: 0 }], "pay-x402", "pay-x402"],
    ["EVM ref on another chain than the rail", [{ ...evm, chainId: 1 }], "pay-evm-erc20", "pay-evm-erc20"],
    ["Solana ref on another cluster than the rail", [{ ...solana, cluster: "devnet" }], "pay-solana-spl", "pay-solana-spl"],
  ];
  for (const [name, refs, rail, phase, phaseIndex] of cases) await t.test(name, async () => {
    const valid = rail === "pay-dem" ? { ...demos, txHash: demosTxHash("other") } :
      rail === "pay-x402" ? { kind: "x402-event", chainId: 8453, settlementTxHash: demosTxHash("other"), logIndex: 0,
        httpResource: "https://seller.example/pay", paymentReceiptHash: "cd".repeat(32), protocolVersion: "2" } :
        rail === "pay-solana-spl" ? { ...solana, instructionIndex: 2 } :
          { ...evm, txHash: demosTxHash("other") };
    const record = await indexTwoJobs(refs, [valid], rail, phase, phaseIndex);
    assert.equal(record.deals[0].refsVerified, true, name);
    assert.equal(record.deals[0].reputationEligible, false, name);
    assert.equal(record.deals[1].reputationEligible, true, name);
    assert.equal(record.reputation.bundleCount, 1, name);
    assert.equal(record.reputation.completed, 1, name);
    assert.deepEqual(record.reputation.bundleRefs?.map((ref) => ref.id), ["00RMM3D7M9Q2VC68EPBNNKEX3X"], name);
    assert.deepEqual(record.reputation.observedTransactionalVolume, [{ currency: "DEM", amount: "1.25" }], name);
    assert.deepEqual(record.reputation.transactionCountByCurrency, [{ currency: "DEM", count: 1 }], name);
    assert.equal(record.listings[0].reputationHint!.bundleCount, 1, name);
  });
});

/** One seller's deals through the read projection, with a single uncached listing hint. */
const sb2Seller = (deals: DealRecord[], generatedAt: number): SellerRecord => rebuildCatalogObservations({
  catalogVersion: "1", generatedAt, sellers: [{
    primaryClaim: dids[1], displayName: "SB-2", cci: [], registeredAt: 1, lastIndexedAt: 1, deals,
    listings: [{ listingId: "sb2", version: 1, offering: { category: "services.test" } } as unknown as ListingSummary],
  } as unknown as SellerRecord],
}).sellers[0];

test("TP-1 local no-authority adaptation: an earlier or tied producer timestamp never wins", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/sb2-collision-authority-v0.8.subset.json", import.meta.url), "utf8")) as {
    source: { commit: string; path: string };
    vectors: Array<{
      name: string; trustedContext: { settlementAuthorities: unknown[] };
      protocolInput: { records: Array<{ contentHash: string; jobId: string; phaseIndex: number; settlementTxId: string; observedAt: number; sr2AnchorOrder: number }> };
      expected: string;
      want: { countedEvidenceHashes: string[]; rejectedEvidenceHashes: string[]; indeterminateEvidenceHashes: string[] };
    }>;
  };
  assert.equal(fixture.source.commit, "d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20");
  assert.deepEqual(fixture.vectors.map((vector) => vector.name), [
    "no-binding-collision-voids-both", "backdated-attacker-does-not-win", "equal-producer-timestamps-do-not-tie-break",
    "single-record-no-collision-counts", "idempotent-identical-record-counts-once", "distinct-event-identifiers-both-count",
  ]);
  for (const vector of fixture.vectors) {
    const deals: DealRecord[] = vector.protocolInput.records.map((record, index) => ({
      jobId: record.jobId, rail: "pay-x402", buyerBundleRef: locator(200 + index), sellerBundleRef: locator(210 + index),
      owners: { buyer: dids[0], seller: dids[1] }, signatureVerified: true, refsVerified: true, reputationEligible: true,
      sellerOutcome: "completed", finalisedAt: 100, anchorTimestamp: 100 + record.sr2AnchorOrder, verifiedAt: 1,
      bundleContentHash: record.contentHash, agreementPrice: { amount: "1", currency: "USDC" }, category: "services.test",
      settlementTxIds: [{ id: record.settlementTxId, observedAt: record.observedAt, phaseIndex: record.phaseIndex }],
    }));
    for (const order of [deals, [...deals].reverse()]) {
      const counted = deriveSellerReputation(order, 0, 10_000).bundleRefs!.map((ref) => ref.contentHash);
      for (const hash of [...vector.want.rejectedEvidenceHashes, ...vector.want.indeterminateEvidenceHashes]) {
        assert.ok(!counted.includes(hash), `${vector.name}: ${hash.slice(0, 4)} must not count`);
      }
      // The Directory verifies no settlement-side authority (SB-3), so every
      // authority vector's group stays indeterminate here.
      assert.deepEqual(counted, vector.trustedContext.settlementAuthorities.length === 0
        ? vector.want.countedEvidenceHashes : [], vector.name);
      // The listing hint and the read projection share the same rule.
      const projected = sb2Seller(order.map((deal) => ({ ...deal, settlementProjectionVersion: SETTLEMENT_PROJECTION_VERSION })), 10_000);
      assert.equal(projected.reputation!.bundleCount, counted.length, vector.name);
      assert.equal(projected.listings[0].reputationHint!.bundleCount, counted.length, vector.name);
    }
  }
});

test("SB-2 counts one session's identical records once and excludes a session presented as two bundles", () => {
  const deal = (values: Partial<DealRecord> = {}): DealRecord => ({
    jobId: "01KTY8ZJ00CW7KSECW3FS6PQPK", rail: "pay-dem", buyerBundleRef: locator(220), sellerBundleRef: locator(221),
    owners: { buyer: dids[0], seller: dids[1] }, signatureVerified: true, refsVerified: true, reputationEligible: true,
    settlementProjectionVersion: SETTLEMENT_PROJECTION_VERSION, sellerOutcome: "completed", finalisedAt: 100, verifiedAt: 1,
    bundleContentHash: "1".repeat(64), agreementPrice: { amount: "1", currency: "DEM" }, category: "services.test",
    settlementTxIds: [{ id: `demos:${"ab".repeat(32)}`, observedAt: 100, phaseIndex: 2 }], ...values,
  });
  const cases: Array<[string, DealRecord[], number]> = [
    ["one record", [deal()], 1],
    ["the same record twice", [deal(), deal()], 1],
    // A Demos claim spelled as a bare key is the same signing identity.
    ["the same record with another claim spelling", [deal(), deal({ owners: { buyer: dids[0].replace("did:demos:agent:", "0x"), seller: dids[1] } })], 1],
    ["one copy inside and one outside the window", [deal({ finalisedAt: 900 }), deal()], 1],
    ["the same record twice without any settlement id", [deal({ settlementTxIds: [] }), deal({ settlementTxIds: [] })], 1],
    ["one session presented as two bundles", [deal(), deal({ bundleContentHash: "2".repeat(64), sellerOutcome: "failed-perm" })], 0],
    ["two bundles without any settlement id", [deal({ settlementTxIds: [] }), deal({ settlementTxIds: [], bundleContentHash: "2".repeat(64) })], 0],
    ["two records without a content hash", [deal({ bundleContentHash: undefined as unknown as string }), deal({ bundleContentHash: undefined as unknown as string })], 0],
    ["one settlement under two phase indices of one session", [deal(), deal({ settlementTxIds: [{ id: `demos:${"ab".repeat(32)}`, observedAt: 100, phaseIndex: 3 }] })], 0],
    ["one settlement under another job", [deal(), deal({ jobId: "01KTY8ZJ01CW7KSECW3FS6PQPK", bundleContentHash: "3".repeat(64) })], 0],
    ["one settlement under another buyer's job with the same jobId", [deal(), deal({ owners: { buyer: dids[2], seller: dids[1] }, bundleContentHash: "3".repeat(64) })], 0],
    // A jobId is unique only per producer: the parties are part of the session.
    ["another buyer's session reusing the jobId with its own settlement", [deal(), deal({ owners: { buyer: dids[2], seller: dids[1] },
      bundleContentHash: "3".repeat(64), settlementTxIds: [{ id: `demos:${"cd".repeat(32)}`, observedAt: 100, phaseIndex: 2 }] })], 2],
  ];
  for (const [name, deals, expected] of cases) {
    for (const order of [deals, [...deals].reverse()]) {
      const reputation = deriveSellerReputation(order, 0, 200);
      assert.equal(reputation.bundleCount, expected, name);
      assert.equal(reputation.completed, expected, name);
      assert.equal(reputation.bundleRefs!.length, expected, name);
      assert.deepEqual(reputation.transactionCountByCurrency, expected ? [{ currency: "DEM", count: expected }] : [], name);
      const seller = sb2Seller(order, 200);
      assert.equal(seller.reputation!.bundleCount, expected, name);
      assert.equal(seller.listings[0].reputationHint!.bundleCount, expected, name);
    }
  }
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
  assert.equal(isNeutralCancellation("aborted-by-self", { claimedPolicy: "pre-commit" },
    { cancellationPolicy: "pre-commit" }, [{ kind: "commit-payee-bound-agreement", outcome: "ok" }]), false);
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
  const mixedScheme = structuredClone(result);
  (mixedScheme.signature as Obj).signer = `DID:demos:agent:${dids[0].slice(-64)}`;
  maps.set(locator(9), mixedScheme);
  assert.equal(
    await deriveIdentityTier(identity, async () => policy, 100, async (at) => maps.get(at) ?? null),
    "institutional",
    "trusted signer comparison uses its resolved canonical identity",
  );
  assert.equal(await deriveIdentityTier(identity, async () => policy, 201, async (at) => maps.get(at) ?? null), "self-declared");
});

/** Index the seller's registration over the fixture's stubbed storage. */
async function indexFixture(fixture: Awaited<ReturnType<typeof vector>>, extra: Partial<Registration> = {}, resolveRecipe?: (scheme: string, version: number) => Promise<RecipePolicy | null>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const data = maps.get(String(input).split("/").pop() ?? "");
    return new Response(JSON.stringify(data ? { success: true, owner: `0x${(extra.primaryClaim ?? dids[1]).slice(-64)}`, programName: "dacs:test", metadata: { logicalAddress: evidenceAddresses.get(String(input).split("/").pop() ?? "") }, data } : { success: false }),
      { status: data ? 200 : 404, headers: { "content-type": "application/json" } });
  };
  try {
    return await indexRegistration({ primaryClaim: dids[1], displayName: "seller", listingAnchors: [fixture.locators.listing], ...extra },
      undefined, async () => { throw new Error("identity unavailable"); }, resolveRecipe);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("a verified two-copy deal publishes exactly the evidence its authoritative copy signs", async () => {
  const fixture = await vector("00GP9P2HFCC58HN6BJ12E331H9", 130);
  const deal = registeredDeal("00GP9P2HFCC58HN6BJ12E331H9", fixture.locators.buyer, fixture.locators.seller);
  const record = await indexFixture(fixture, { deals: [deal], bundleBindings: [
    await bindingFor(deal.jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
    await bindingFor(deal.jobId, "seller", fixture.locators.seller, fixture.sellerBundle, 1),
  ] });
  assert.ok(isSettlementEvidence(fixture.evidence));
  const [published] = record.deals;
  assert.deepEqual({
    signatureVerified: published.signatureVerified, refsVerified: published.refsVerified,
    reputationEligible: published.reputationEligible, rail: published.rail, outcome: published.outcome,
    sellerOutcome: published.sellerOutcome, anchoredByRole: published.anchoredByRole,
    bundleContentHash: published.bundleContentHash, cancellationNeutral: published.cancellationNeutral,
    finalisedAt: published.finalisedAt, agreementPrice: published.agreementPrice, category: published.category,
    ratings: published.ratings, settlementTxIds: published.settlementTxIds,
  }, {
    signatureVerified: true, refsVerified: true, reputationEligible: true, rail: "demos-native:DEM", outcome: "completed",
    sellerOutcome: "completed", anchoredByRole: "seller", bundleContentHash: artifactHash(fixture.sellerBundle, "bundle"),
    cancellationNeutral: false, finalisedAt: 120, agreementPrice: { amount: "1.25", currency: "DEM" }, category: "services.test",
    ratings: [{ rater: dids[0], target: dids[1], targetRole: "seller", value: 5, ratedAt: 110, contentHash: artifactHash(fixture.rating, "rating") }],
    settlementTxIds: [{ id: `demos:${demosTxHash("00GP9P2HFCC58HN6BJ12E331H9")}`, observedAt: 100, phaseIndex: 2 }],
  });
  const { categoryScope, completionRate, averageSellerRating, bundleCount } = record.listings[0].reputationHint!;
  assert.deepEqual({ categoryScope, completionRate, averageSellerRating, bundleCount },
    { categoryScope: "services.test", completionRate: null, averageSellerRating: null, bundleCount: 1 });
  assert.equal(record.reputation.bundleCount, 1);
});

test("signed evidence with absent or malformed transaction refs cannot deduplicate independent jobs", async () => {
  for (const refs of [undefined, null, { txId: "not-an-array" }, [{}, null, { txId: null }, { id: null }, { txId: "" }, { id: "" }]]) {
    const allMaps = new Map<string, Obj>();
    const fixtures: Awaited<ReturnType<typeof vector>>[] = [];
    const deals: RegisteredDeal[] = [];
    const bindings: BundleBinding[] = [];
    for (let index = 0; index < 2; index++) {
      const jobId = `0${index}EMPTYTXREFS0000000000000`;
      const fixture = await vector(jobId, 300 + index * 10);
      const evidenceScope = signedScope(fixture.evidence, "evidence");
      if (refs === undefined) delete evidenceScope.paymentTxRefs;
      else evidenceScope.paymentTxRefs = refs;
      const evidence = { ...evidenceScope, signature: await sign(evidenceScope, "evidence", 1) };
      maps.set(fixture.locators.evidence, evidence);
      for (const [role, raw, at] of [["buyer", fixture.buyerBundle, fixture.locators.buyer],
        ["seller", fixture.sellerBundle, fixture.locators.seller]] as const) {
        const scope = signedScope(raw, "bundle");
        scope.settlementEvidence = [ref(fixture.locators.evidence, evidence, "evidence")];
        const bundle = { ...scope, signatures: [await sign(scope, "bundle", 0, true), await sign(scope, "bundle", 1, true)], anchoredByRole: role };
        maps.set(at, bundle);
        bindings.push(await bindingFor(jobId, role, at, bundle, role === "buyer" ? 0 : 1));
      }
      fixtures.push(fixture);
      deals.push(registeredDeal(jobId, fixture.locators.buyer, fixture.locators.seller));
      for (const [at, raw] of maps) allMaps.set(at, raw);
    }
    maps.clear();
    for (const [at, raw] of allMaps) maps.set(at, raw);
    const record = await indexFixture(fixtures[0], { deals, bundleBindings: bindings });
    assert.equal(record.deals.length, 2);
    for (const published of record.deals) {
      assert.equal(published.signatureVerified, true, JSON.stringify(refs));
      assert.equal(published.refsVerified, true, JSON.stringify(refs));
      // SB-1: success evidence without a projectable TxRef is not counted at all.
      assert.equal(published.reputationEligible, false, JSON.stringify(refs));
      assert.deepEqual(published.settlementTxIds, [], "no settlement id may be fabricated");
    }
    assert.equal(record.reputation.bundleCount, 0, JSON.stringify(refs));
    assert.equal(record.reputation.completed, 0);
    assert.equal(record.reputation.completionRate, null);
    assert.deepEqual(record.reputation.observedTransactionalVolume, []);
  }
});

test("listing reputation includes exact categories and dot descendants, with testnet rates unavailable", async () => {
  const allMaps = new Map<string, Obj>();
  const fixtures: Awaited<ReturnType<typeof vector>>[] = [];
  const deals: RegisteredDeal[] = [];
  const bindings: BundleBinding[] = [];
  const categories = ["services.test", "services.test.child", "services.testing", "other.services.test"];
  for (const [index, category] of categories.entries()) {
    const jobId = `0${index}CATEGQRY0000000000000000`;
    const fixture = await vector(jobId, 400 + index * 10);
    const listingScope = signedScope(fixture.listing, "listing");
    listingScope.listingId = `svc-${index}`;
    listingScope.offering = { ...listingScope.offering as Obj, category };
    fixture.listing = { ...listingScope, signature: await sign(listingScope, "listing", 1) };
    maps.set(fixture.locators.listing, fixture.listing);
    const listingRef = { listingId: `svc-${index}`, version: 1, contentHash: artifactHash(fixture.listing, "listing") };
    fixture.buyerBundle = { ...fixture.buyerBundle, listingRef };
    fixture.sellerBundle = { ...fixture.sellerBundle, listingRef };
    await installAgreement(fixture, { ...signedScope(fixture.agreement, "agreement"), listingRef });
    for (const [role, at] of [["buyer", fixture.locators.buyer], ["seller", fixture.locators.seller]] as const) {
      const scope = signedScope(maps.get(at)!, "bundle");
      // One descendant is a seller failure, the lookalikes are completions.
      if (index === 1) scope.outcome = role === "seller" ? "failed-perm" : "failed-counterparty";
      const bundle = { ...scope, signatures: [await sign(scope, "bundle", 0, true), await sign(scope, "bundle", 1, true)], anchoredByRole: role };
      maps.set(at, bundle);
      bindings.push(await bindingFor(jobId, role, at, bundle, role === "buyer" ? 0 : 1));
    }
    fixtures.push(fixture);
    deals.push(registeredDeal(jobId, fixture.locators.buyer, fixture.locators.seller));
    for (const [at, raw] of maps) allMaps.set(at, raw);
  }
  maps.clear();
  for (const [at, raw] of allMaps) maps.set(at, raw);
  const record = await indexFixture(fixtures[0], { listingAnchors: fixtures.map((f) => f.locators.listing), deals, bundleBindings: bindings });
  assert.equal(record.reputation.bundleCount, 4);
  assert.equal(record.reputation.completed, 3);
  assert.equal(record.reputation.completionRate, null);
  assert.deepEqual(record.listings.map((l) => ({ category: l.offering.category,
    count: l.reputationHint!.bundleCount, rate: l.reputationHint!.completionRate })), [
    { category: "services.test", count: 2, rate: null },
    { category: "services.test.child", count: 1, rate: null },
    { category: "services.testing", count: 1, rate: null },
    { category: "other.services.test", count: 1, rate: null },
  ]);
});

test("a divergent two-copy deal in the listing's category never enters its reputationHint", async () => {
  // Each copy verifies on its own, but the seller copy reports another outcome
  // (#230), so the deal is unverified: neither the seller's reputation nor the
  // listing's hint may count it.
  const fixture = await vector("hint-divergent-job", 140);
  const sellerScope = signedScope(fixture.sellerBundle, "bundle");
  sellerScope.outcome = "failed-counterparty";
  sellerScope.phaseSummary = [{ index: 2, kind: "settle", outcome: "fail", errorClass: "counterparty" }];
  const divergentSellerCopy = {
    ...sellerScope,
    signatures: [await sign(sellerScope, "bundle", 0, true), await sign(sellerScope, "bundle", 1, true)],
    anchoredByRole: "seller",
  };
  maps.set(fixture.locators.seller, divergentSellerCopy);
  const deal = registeredDeal("hint-divergent-job", fixture.locators.buyer, fixture.locators.seller);
  const record = await indexFixture(fixture, { deals: [deal], bundleBindings: [
    await bindingFor(deal.jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
    await bindingFor(deal.jobId, "seller", fixture.locators.seller, divergentSellerCopy, 1),
  ] });
  const [published] = record.deals;
  assert.deepEqual(
    { refsVerified: published.refsVerified, reputationEligible: published.reputationEligible, category: published.category },
    { refsVerified: false, reputationEligible: false, category: "services.test" },
  );
  const { categoryScope, completionRate, averageSellerRating, bundleCount } = record.listings[0].reputationHint!;
  assert.deepEqual({ categoryScope, completionRate, averageSellerRating, bundleCount },
    { categoryScope: "services.test", completionRate: null, averageSellerRating: null, bundleCount: 0 });
  assert.equal(record.reputation.bundleCount, 0);
});

test("a BundleBinding resolves only to the copy anchored by the role it names", async () => {
  // Both copies share one bundle hash; only the unhashed anchoredByRole tells them apart (BB-5).
  const fixture = await vector("00KZWZMSMTGEPXVTGBK05E648P", 150);
  const deal = registeredDeal("00KZWZMSMTGEPXVTGBK05E648P", fixture.locators.buyer, fixture.locators.seller);
  const record = await indexFixture(fixture, { deals: [deal], bundleBindings: [
    await bindingFor(deal.jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
    await bindingFor(deal.jobId, "seller", fixture.locators.buyer, fixture.buyerBundle, 1),
  ] });
  assert.ok(isSettlementEvidence(fixture.evidence));
  const [published] = record.deals;
  assert.equal(published.signatureVerified, false, "the seller side is indeterminate, so nothing is published as verified");
  assert.equal(published.refsVerified, false);
  assert.equal(published.outcome, undefined);
  assert.equal(published.anchoredByRole, undefined);
  assert.equal(record.reputation.bundleCount, 0);
});

test("seller labels come only from a verifiable owner signature and verified identity claims", async () => {
  const fixture = await vector("00FYGZPCJ0W949JJJ63Q1SCFAB", 170);
  const base = { primaryClaim: dids[1], displayName: "seller", listingAnchors: [fixture.locators.listing] };
  const signed = async (signedAt: number, extra: Partial<Registration> = {}) => {
    const message = registrationMessage({ ...base, ...extra }, signedAt);
    const value = Buffer.from(await ed25519Sign(Buffer.from(message, "utf8"), privateKeyFromSeed(seeds[1]))).toString("hex");
    return { ...extra, ownerSignature: { message, signature: value, signedAt } };
  };
  const unsigned = await indexFixture(fixture);
  assert.equal(unsigned.ownerRegistered, false);
  // A v0.1 IdentityBundle with only its signing key is self-declared, never verified or institutional.
  assert.equal(unsigned.identityTier, "self-declared");
  assert.ok(unsigned.identityBundle);
  assert.equal((await indexFixture(fixture, await signed(Date.now()))).ownerRegistered, true);
  // Freshness gates submission only; a stored signature still binds on every reindex.
  assert.equal((await indexFixture(fixture, await signed(1))).ownerRegistered, true);
  const { ownerSignature: other } = await signed(Date.now(), { displayName: "someone else" });
  assert.equal((await indexFixture(fixture, { ownerSignature: other })).ownerRegistered, false, "a signature over other content");
  // A verifier that throws on a malformed stored signature never grants the badge.
  const malformed = await signed(Date.now());
  (malformed.ownerSignature as { signature: unknown }).signature = 42;
  assert.equal((await indexFixture(fixture, malformed)).ownerRegistered, false);
});

test("SB-1 recovers the PC-2 tuple from the storage metadata of SDK-valid evidence anchors", async () => {
  const fixture = await vector("01KTY8ZJ00CW7KSECW3FS6PQPK", 3000);
  const jobId = String(fixture.evidence.jobId);
  assert.ok(isSettlementEvidence(fixture.evidence), "positive evidence passes the pinned SDK validator");
  assert.equal(Object.hasOwn(fixture.evidence, "phaseIndex"), false);
  const extra = { deals: [registeredDeal(jobId, fixture.locators.buyer, fixture.locators.seller)], bundleBindings: [
    await bindingFor(jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
    await bindingFor(jobId, "seller", fixture.locators.seller, fixture.sellerBundle, 1),
  ] };
  const canonical = paymentEvidenceAddress(jobId, "demos-native:DEM", 2);
  const accepted = await indexFixture(fixture, extra);
  assert.equal(accepted.reputation.bundleCount, 1);
  assert.equal(accepted.deals[0].settlementTxIds?.[0].phaseIndex, 2);
  for (const address of [
    undefined, canonical.replace(jobId, "01KTY8ZJ01CW7KSECW3FS6PQPK"),
    canonical.replace(jobId, jobId.toLowerCase()), canonical.replace(jobId, "job-1"),
    canonical.replace("demos-native%3ADEM", "x402%3Adefault"),
    canonical.replace("%3A", "%3a"), canonical.replace("%3A", ":"),
    canonical.replace("%3A", "%253A"), canonical.replace(":2", ":1"),
    canonical.replace(":2", ":02"), canonical.replace(":2", ":9007199254740992"),
    canonical + ":resolved", canonical + ":extra",
  ]) {
    if (address === undefined) evidenceAddresses.delete(fixture.locators.evidence);
    else evidenceAddresses.set(fixture.locators.evidence, address);
    const result = await indexFixture(fixture, extra);
    assert.equal(result.deals[0].refsVerified, true, String(address));
    assert.equal(result.deals[0].reputationEligible, false, String(address));
    assert.deepEqual(result.deals[0].settlementTxIds, [], String(address));
    assert.equal(result.reputation.bundleCount, 0, String(address));
    assert.deepEqual(result.reputation.bundleRefs, [], String(address));
    assert.deepEqual(result.reputation.observedTransactionalVolume, [], String(address));
    assert.equal(result.listings[0].reputationHint!.bundleCount, 0, String(address));
  }
});

test("SB-2 excludes a shared settlement across two independently signed sellers before window and category projection", async () => {
  const shared = { kind: "demos", txHash: "ab".repeat(32) };
  const sellers = [];
  for (const [index, jobId] of ["01KTY8ZJ00CW7KSECW3FS6PQPK", "01KTY8ZJ01CW7KSECW3FS6PQPK"].entries()) {
    const signer = index + 1;
    const fixture = await vector(jobId, 4000 + index * 100, [shared], "pay-dem", "pay-dem", 2, signer);
    assert.ok(isSettlementEvidence(fixture.evidence));
    const seller = await indexFixture(fixture, {
      primaryClaim: dids[signer],
      deals: [{ ...registeredDeal(jobId, fixture.locators.buyer, fixture.locators.seller), owners: { buyer: dids[0], seller: dids[signer] } }],
      bundleBindings: [
        await bindingFor(jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
        await bindingFor(jobId, "seller", fixture.locators.seller, fixture.sellerBundle, signer),
      ],
    });
    assert.equal(seller.reputation.bundleCount, 1, "each signed job is eligible before the competing claim arrives");
    sellers.push(seller);
  }
  const catalog = { catalogVersion: "1" as const, generatedAt: 200, sellers };
  for (const order of [sellers, [...sellers].reverse()]) {
    for (const result of [rebuildCatalogObservations({ ...catalog, sellers: order }), projectTestnetCatalog({ ...catalog, sellers: order })]) {
      for (const seller of result.sellers) {
        assert.equal(seller.reputation.bundleCount, 0);
        assert.equal(seller.reputation.completed, 0);
        assert.equal(seller.reputation.totalAgreements, 0);
        assert.deepEqual(seller.reputation.bundleRefs, []);
        assert.deepEqual(seller.reputation.observedTransactionalVolume, []);
        assert.deepEqual(seller.reputation.transactionCountByCurrency, []);
        assert.equal(seller.listings[0].reputationHint!.bundleCount, 0);
        assert.equal(seller.reputation.counterpartyFaultRate, null);
      }
    }
  }
  sellers[1].deals[0].finalisedAt = 300;
  sellers[1].deals[0].category = "another.category";
  sellers[0].reputation.windowEnd = 200;
  assert.equal(projectTestnetCatalog(catalog).sellers[0].reputation.bundleCount, 0, "a later/out-of-category competitor still excludes the earlier claim");
  const rebuilt = rebuildCatalogObservations(catalog);
  assert.equal(rebuilt.sellers[0].deals[0].ratings![0].value, 5, "writer rebuilding retains source evidence");
  assert.ok(rebuilt.sellers.every((seller) => seller.deals[0].reputationEligible), "collision exclusion does not destroy source eligibility");
});

test("SB-1 rejects valid Base58 outside 64 decoded bytes", async () => {
  for (const size of [63, 64, 65, 89]) {
    const signature = "1".repeat(size);
    const ref = { kind: "solana-instruction", cluster: "mainnet", signature, instructionIndex: 0 };
    assert.equal(settlementTxId(ref), size === 64 ? `solana:mainnet:${signature}:0` : null, String(size));
    const record = await indexTwoJobs([ref], [{ ...ref, signature: "2" + "1".repeat(86), instructionIndex: 1 }], "pay-solana-spl");
    assert.equal(record.deals[0].reputationEligible, size === 64, String(size));
  }
});

test("SB-2 subset preserves the pinned upstream inputs and positive authority expectations", () => {
  const bytes = readFileSync(new URL("./fixtures/sb2-collision-authority-v0.8.json", import.meta.url));
  const upstream = JSON.parse(bytes.toString());
  const subset = JSON.parse(readFileSync(new URL("./fixtures/sb2-collision-authority-v0.8.subset.json", import.meta.url), "utf8"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "2f01d94de434195d032fa1336702a8e45da21c0120879412624d4c9ac429a3ad");
  assert.equal(subset.source.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(upstream.count, 32);
  for (const vector of subset.vectors) {
    assert.deepEqual(vector, upstream.vectors.find((entry: { name: string }) => entry.name === vector.name));
    if (vector.trustedContext.settlementAuthorities.length > 0) {
      assert.equal(vector.expected, "pass");
      assert.deepEqual(vector.want.countedEvidenceHashes, ["1".repeat(64)]);
    }
  }
});

test("SB-1 keeps registry identity, pinned handler and signed pipeline context distinct", async () => {
  const fixture = await vector("01KTY8ZJ00CW7KSECW3FS6PQPK", 5000);
  const evidence = [{ raw: fixture.evidence, logicalAddress: evidenceAddresses.get(fixture.locators.evidence) }];
  const context = {
    jobId: fixture.evidence.jobId, railId: "demos-native:DEM", railRegistryVersion: 1,
    phaseSummary: fixture.buyerBundle.phaseSummary, pipeline: fixture.listing.pipeline,
  };
  assert.equal(settlementClaims(evidence, context).projected, true);
  for (const altered of [
    { ...context, railId: "pay-dem" }, { ...context, railId: "custom-demos" },
    { ...context, railId: "__proto__" }, { ...context, railRegistryVersion: 2 },
    { ...context, railRegistryVersion: undefined },
    { ...context, jobId: "01KTY8ZJ01CW7KSECW3FS6PQPK" },
    { ...context, pipeline: [{}, {}, { kind: "pay-x402", parameters: { rail: "demos-native:DEM" } }] },
    { ...context, pipeline: [{}, {}, { kind: "pay-dem", parameters: { rail: "x402:default" } }] },
    { ...context, phaseSummary: [{ index: 2, kind: "settle", outcome: "fail" }] },
  ]) assert.equal(settlementClaims(evidence, altered).projected, false);
  assert.equal(settlementClaims([{ raw: { ...fixture.evidence, logicalAddress: evidence[0].logicalAddress } }], context).projected, false,
    "an artifact annotation cannot replace the anchor metadata-of-record");
  assert.equal(settlementClaims([{ ...evidence[0], raw: { ...fixture.evidence, phaseIndex: 2 } }], context).projected, false,
    "the SDK-refused phaseIndex field cannot repair or replace address binding");
  // SB-1 / CORE JID-1: the pinned SDK checks only that jobId is a non-empty
  // string, so a tuple that agrees everywhere on a non-JID-1 jobId must still
  // mint no settlement id.
  const validJobId = String(fixture.evidence.jobId);
  for (const jobId of [
    validJobId.toLowerCase(), `8${validJobId.slice(1)}`, `${validJobId.slice(0, 25)}U`, `${validJobId}0`,
  ]) {
    const claims = settlementClaims(
      [{ raw: { ...fixture.evidence, jobId }, logicalAddress: paymentEvidenceAddress(jobId, "demos-native:DEM", 2) }],
      { ...context, jobId },
    );
    assert.deepEqual(claims, { settlementTxIds: [], projected: false }, jobId);
  }
});

test("the rail tables split the pinned DACS-4 §9.4.2 registry into 8 projected and 5 withheld rows", async () => {
  // DACS-4-SETTLE.md §9.4.2 at d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20, in table order.
  const pinnedRegistry: Record<string, string> = {
    "evm-erc20:1:USDC": "pay-evm-erc20", "evm-erc20:8453:USDC": "pay-evm-erc20",
    "evm-erc20:42161:USDC": "pay-evm-erc20", "evm-erc20:137:USDC": "pay-evm-erc20",
    "solana-spl:mainnet:USDC": "pay-solana-spl", "solana-spl:mainnet:USDT": "pay-solana-spl",
    "cross-chain-htlc:USDC": "pay-cross-chain-htlc",
    "cross-chain-liquidity-tank:USDC": "pay-cross-chain-liquidity-tank",
    "demos-native:DEM": "pay-dem", "ap2:visa-direct": "pay-ap2", "ap2:mastercard-send": "pay-ap2",
    "ap2:stripe-paymentintents": "pay-ap2", "x402:default": "pay-x402",
  };
  assert.deepEqual(Object.keys(PINNED_RAIL_HANDLERS).filter((rail) => Object.hasOwn(UNPROJECTED_PINNED_RAILS, rail)), []);
  assert.deepEqual({ ...PINNED_RAIL_HANDLERS, ...UNPROJECTED_PINNED_RAILS }, pinnedRegistry);
  assert.equal(Object.keys(PINNED_RAIL_HANDLERS).length, 8);

  const fixture = await vector("01KTY8ZJ00CW7KSECW3FS6PQPK", 5000);
  for (const [railId, handler] of Object.entries(UNPROJECTED_PINNED_RAILS)) {
    // Every signed field agrees on the withheld rail and handler; it still mints nothing.
    const jobId = String(fixture.evidence.jobId);
    const raw = { ...fixture.evidence, phase: handler };
    const claims = settlementClaims([{ raw, logicalAddress: paymentEvidenceAddress(jobId, railId, 2) }], {
      jobId, railId, railRegistryVersion: 1,
      phaseSummary: [{ index: 2, kind: handler, outcome: "ok" }],
      pipeline: [{}, {}, { kind: handler, parameters: { rail: railId } }],
    });
    assert.deepEqual(claims, { settlementTxIds: [], projected: false }, railId);
  }
});

/**
 * A current deal shaped like the pinned SDK producer's: the bundle names its
 * phases with Standard PhaseType kinds and also signs success delivery evidence.
 */
async function deliveredVector(jobId: string, offset: number, payKind: string, deliveryPhase: Obj | null) {
  const fixture = await vector(jobId, offset);
  const at = (n: number) => locator(offset + n);
  const payload: Obj = { jobId, result: "delivered" };
  maps.set(at(7), payload);
  const attestationRef = { anchor: { kind: "storage-program", locator: at(7) }, contentHash: contentHash(payload) };
  const deliveryScope: Obj = { evidenceVersion: "1", jobId, phase: "deliver-attested-payload", outcome: "success",
    deliverableContentHash: contentHash(payload), deliverableAnchor: attestationRef.anchor, attestationRef, observedAt: 105 };
  const delivery: Obj = { ...deliveryScope, signature: await sign(deliveryScope, "evidence", 1) };
  maps.set(at(8), delivery);
  for (const [role, where] of [["buyer", fixture.locators.buyer], ["seller", fixture.locators.seller]] as const) {
    const scope = signedScope(maps.get(where)!, "bundle");
    scope.phaseSummary = [{ index: 2, kind: payKind, outcome: "ok" }, ...(deliveryPhase ? [deliveryPhase] : [])];
    scope.settlementEvidence = [ref(fixture.locators.evidence, fixture.evidence, "evidence"), ref(at(8), delivery, "evidence")];
    const bundle = { ...scope, signatures: [await sign(scope, "bundle", 0, true), await sign(scope, "bundle", 1, true)], anchoredByRole: role };
    maps.set(where, bundle);
    if (role === "buyer") fixture.buyerBundle = bundle;
    else fixture.sellerBundle = bundle;
  }
  return { ...fixture, delivery };
}

test("SB-1 accepts the Standard PhaseType pay kind and binds success delivery evidence to its signed phase", async () => {
  const jobId = "01KTY8ZJ02CW7KSECW3FS6PQPK";
  const deliver = { index: 3, kind: "deliver-attested-payload", outcome: "ok" };
  const indexDelivered = async (offset: number, payKind: string, deliveryPhase: Obj | null) => {
    const fixture = await deliveredVector(jobId, offset, payKind, deliveryPhase);
    assert.ok(isSettlementEvidence(fixture.delivery), "the delivery evidence passes the pinned SDK validator");
    return indexFixture(fixture, { deals: [registeredDeal(jobId, fixture.locators.buyer, fixture.locators.seller)], bundleBindings: [
      await bindingFor(jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
      await bindingFor(jobId, "seller", fixture.locators.seller, fixture.sellerBundle, 1),
    ] });
  };
  for (const [name, payKind, deliveryPhase] of [
    ["PhaseType pay and delivery kinds", "pay-dem", deliver],
    ["pre-registry settle and deliver labels", "settle", { ...deliver, kind: "deliver" }],
  ] as const) {
    const record = await indexDelivered(6000, payKind, deliveryPhase);
    const [deal] = record.deals;
    assert.equal(deal.refsVerified, true, name);
    assert.equal(deal.reputationEligible, true, name);
    assert.deepEqual(deal.settlementTxIds, [{ id: `demos:${demosTxHash(jobId)}`, observedAt: 100, phaseIndex: 2 }],
      `${name}: delivery evidence adds no settlement id`);
    assert.equal(record.reputation.bundleCount, 1, name);
    assert.equal(record.reputation.completed, 1, name);
    assert.equal(record.listings[0].reputationHint!.bundleCount, 1, name);
  }
  for (const [name, payKind, deliveryPhase] of [
    ["delivery evidence without a delivery phase", "pay-dem", null],
    ["delivery phase of another kind", "pay-dem", { ...deliver, kind: "deliver-storage-program" }],
    ["another rail's PhaseType at the pay index", "pay-x402", deliver],
  ] as const) {
    const record = await indexDelivered(6100, payKind, deliveryPhase);
    const [deal] = record.deals;
    assert.equal(deal.refsVerified, true, name);
    assert.equal(deal.reputationEligible, false, name);
    assert.equal(record.reputation.bundleCount, 0, name);
    assert.equal(record.reputation.completed, 0, name);
    assert.deepEqual(record.reputation.bundleRefs, [], name);
    assert.deepEqual(record.reputation.observedTransactionalVolume, [], name);
    assert.equal(record.listings[0].reputationHint!.bundleCount, 0, name);
  }

  // Beside a bound payment claim, the delivery arm alone decides `projected`.
  const fixture = await deliveredVector(jobId, 6200, "pay-dem", deliver);
  const payment = { raw: fixture.evidence, logicalAddress: evidenceAddresses.get(fixture.locators.evidence) };
  const delivery = [payment, { raw: fixture.delivery }];
  const pay = { index: 2, kind: "pay-dem", outcome: "ok" };
  const pipeline = fixture.listing.pipeline as Obj[];
  const context = { jobId, railId: "demos-native:DEM", railRegistryVersion: 1, phaseSummary: fixture.buyerBundle.phaseSummary, pipeline };
  assert.deepEqual(settlementClaims(delivery, context),
    { settlementTxIds: [{ id: `demos:${demosTxHash(jobId)}`, observedAt: 100, phaseIndex: 2 }], projected: true });
  assert.equal(settlementClaims(delivery, { ...context, phaseSummary: [pay, null, { ...deliver, kind: "deliver" }] }).projected, true,
    "the pre-registry deliver label is accepted after a non-record entry");
  for (const [name, altered] of [
    ["no phase summary", { ...context, phaseSummary: undefined }],
    ["no delivery phase", { ...context, phaseSummary: [pay] }],
    ["delivery phase of another kind", { ...context, phaseSummary: [pay, { ...deliver, kind: "deliver-storage-program" }] }],
    ["delivery phase index is not a safe integer", { ...context, phaseSummary: [pay, { ...deliver, index: "3" }] }],
    ["non-record summary entries only", { ...context, phaseSummary: [pay, null, "deliver-attested-payload"] }],
    ["signed pipeline kind differs at the delivery index", { ...context, pipeline: [...pipeline.slice(0, 3), { kind: "deliver-storage-program" }] }],
    ["no signed pipeline phase at the delivery index", { ...context, pipeline: pipeline.slice(0, 3) }],
    ["no signed pipeline", { ...context, pipeline: undefined }],
  ] as const) assert.equal(settlementClaims(delivery, altered).projected, false, name);
  const { deliverableContentHash: _hash, ...unhashed } = fixture.delivery;
  assert.equal(settlementClaims([payment, { raw: unhashed }], context).projected, false, "SDK-invalid delivery evidence");
});

test("SB-1 refuses a signed ok payment phase that no bound payment evidence claims", async () => {
  const jobId = "01KTY8ZJ03CW7KSECW3FS6PQPK";
  const fixture = await deliveredVector(jobId, 6300, "pay-dem", { index: 3, kind: "deliver-attested-payload", outcome: "ok" });
  const payment = { raw: fixture.evidence, logicalAddress: evidenceAddresses.get(fixture.locators.evidence) };
  const delivery = { raw: fixture.delivery };
  const pipeline = fixture.listing.pipeline as Obj[];
  const context = { jobId, railId: "demos-native:DEM", railRegistryVersion: 1, phaseSummary: fixture.buyerBundle.phaseSummary, pipeline };
  assert.equal(settlementClaims([payment, delivery], context).projected, true);
  for (const [name, evidence, altered] of [
    ["no evidence at all", [], context],
    ["delivery evidence only", [delivery], context],
    ["pre-registry settle label without evidence", [], { ...context, phaseSummary: [{ index: 2, kind: "settle", outcome: "ok" }] }],
    ["pay kind named only by the signed pipeline", [], { ...context, phaseSummary: [{ index: 2, kind: "custom", outcome: "ok" }] }],
    ["unsafe pay phase index", [], { ...context, phaseSummary: [{ index: "2", kind: "pay-dem", outcome: "ok" }] }],
    ["withheld rail without evidence", [], { ...context, railId: "ap2:visa-direct",
      phaseSummary: [{ index: 2, kind: "pay-ap2", outcome: "ok" }], pipeline: [{}, {}, { kind: "pay-ap2", parameters: { rail: "ap2:visa-direct" } }] }],
    ["a second ok pay phase without its own claim", [payment], { ...context,
      phaseSummary: [{ index: 2, kind: "pay-dem", outcome: "ok" }, { index: 3, kind: "pay-dem", outcome: "ok" }] }],
  ] as const) assert.equal(settlementClaims(evidence as never, altered).projected, false, name);
  // A pay phase that did not succeed, and no pay phase at all, need no claim.
  for (const phaseSummary of [[{ index: 2, kind: "pay-dem", outcome: "fail" }], [{ index: 0, kind: "commit-agreement", outcome: "ok" }], []]) {
    assert.deepEqual(settlementClaims([], { ...context, phaseSummary }), { settlementTxIds: [], projected: true }, JSON.stringify(phaseSummary));
  }

  // End to end: a completed bundle signing an ok pay phase with no payment
  // evidence counts nowhere.
  for (const [role, where] of [["buyer", fixture.locators.buyer], ["seller", fixture.locators.seller]] as const) {
    const scope = signedScope(maps.get(where)!, "bundle");
    scope.settlementEvidence = [];
    const bundle = { ...scope, signatures: [await sign(scope, "bundle", 0, true), await sign(scope, "bundle", 1, true)], anchoredByRole: role };
    maps.set(where, bundle);
    if (role === "buyer") fixture.buyerBundle = bundle;
    else fixture.sellerBundle = bundle;
  }
  const record = await indexFixture(fixture, { deals: [registeredDeal(jobId, fixture.locators.buyer, fixture.locators.seller)], bundleBindings: [
    await bindingFor(jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
    await bindingFor(jobId, "seller", fixture.locators.seller, fixture.sellerBundle, 1),
  ] });
  assert.equal(record.deals[0].refsVerified, true);
  assert.equal(record.deals[0].sellerOutcome, "completed");
  assert.equal(record.deals[0].reputationEligible, false);
  assert.equal(record.reputation.bundleCount, 0);
  assert.equal(record.reputation.completed, 0);
  assert.deepEqual(record.reputation.observedTransactionalVolume, []);
  assert.equal(record.listings[0].reputationHint!.bundleCount, 0);
  assert.equal(settlementClaims([{ raw: { ...fixture.delivery, phase: "deliver-unknown" } }], context).projected, false,
    "a delivery phase outside the PhaseType registry");
});

test("category scope never matches, or throws on, a deal without a category", () => {
  const deal = { category: undefined } as unknown as DealRecord;
  assert.equal(inCategory(deal, "services"), false);
  assert.equal(inCategory({ category: "services.test" } as DealRecord, "services"), true);
  assert.equal(inCategory({ category: "servicesx" } as DealRecord, "services"), false);
});

test("indexed CCI badges preserve each claim's proof and destination despite malformed preceding rows", async () => {
  const evm = "0x" + "12".repeat(20);
  const solana = "So1anaAddr11111111111111111111111111111";
  const payload = {
    web2: {
      github: [null, {}, { username: 12 }, { username: "MiXeD", proof: "https://proof.test/one" },
        { username: "OtHeR", proof: "https://proof.test/two" }],
      twitter: [{ username: "TwIt", proof: "https://proof.test/twitter" }],
      discord: [{ username: "chat" }], unknown: [{ username: "ignored" }],
    },
    xm: { evm: { mainnet: [{ address: evm }] }, solana: { mainnet: [solana] }, cosmos: { mainnet: ["cosmos123"] } },
    linkedSocials: { telegram: "messenger" },
    ud: [{ domain: "alice.crypto" }],
  };
  const reg = { primaryClaim: dids[1], displayName: "Seller", listingAnchors: [] };
  const expected = [
    { kind: "web2", platform: "discord", handle: "chat", ref: "cci-web2:discord:chat", proofUrl: undefined, linkUrl: undefined },
    { kind: "web2", platform: "github", handle: "MiXeD", ref: "cci-web2:github:MiXeD", proofUrl: "https://proof.test/one", linkUrl: "https://github.com/MiXeD" },
    { kind: "web2", platform: "github", handle: "OtHeR", ref: "cci-web2:github:OtHeR", proofUrl: "https://proof.test/two", linkUrl: "https://github.com/OtHeR" },
    { kind: "web2", platform: "telegram", handle: "messenger", ref: "cci-web2:telegram:messenger", proofUrl: undefined, linkUrl: undefined },
    { kind: "web2", platform: "twitter", handle: "TwIt", ref: "cci-web2:twitter:TwIt", proofUrl: "https://proof.test/twitter", linkUrl: "https://x.com/TwIt" },
    { kind: "wallet", platform: "cosmos", handle: "cosmos123", ref: "cci-xm:cosmos:mainnet:cosmos123", linkUrl: undefined },
    { kind: "wallet", platform: "evm", handle: evm, ref: `cci-xm:evm:mainnet:${evm}`, linkUrl: `https://etherscan.io/address/${evm}` },
    { kind: "wallet", platform: "solana", handle: solana, ref: `cci-xm:solana:mainnet:${solana}`, linkUrl: `https://solscan.io/account/${solana}` },
  ];
  for (const resolved of [{ result: 200, response: payload }, payload, { response: { response: payload } }]) {
    const record = await indexRegistration(reg, undefined, async (hex) => {
      assert.equal(hex, dids[1].slice(-64));
      return resolved;
    });
    assert.deepEqual(record.cci, expected);
    assert.equal(record.identityLinksPresent, true);
    const unavailable = await indexRegistration(reg, record, async () => { throw new Error("resolver unavailable"); });
    assert.deepEqual(unavailable.cci, expected);
    assert.equal(unavailable.identityLinksPresent, true);
  }
  for (const empty of [{}, { response: {} }]) {
    const record = await indexRegistration(reg, undefined, async () => empty);
    assert.deepEqual(record.cci, []);
    assert.equal(record.identityLinksPresent, false);
  }
});

test("indexRegistration publishes verified and institutional tiers with institutional precedence", async () => {
  const fixture = await vector("identity-output", 500);
  const now = Date.now();
  const policies: RecipePolicy[] = [];
  const claims: Obj[] = [];
  for (const [index, scheme, identifier] of [[0, "domain", "verified.example"], [1, "lei", "5493001KJTIIGC8Y1R12"]] as const) {
    const attestation = { authority: scheme };
    const attestationAt = locator(520 + index * 2);
    const resultAt = locator(521 + index * 2);
    maps.set(attestationAt, attestation);
    const scope = { resultVersion: "1", scheme, identifier, recipeVersion: 2, method: "consensus-backed-proxy",
      decision: "pass", reason: "found", fetchedAt: now - 20, verifiedAt: now - 10, validUntil: now + 60_000,
      attestation: { anchor: { kind: "storage-program", locator: attestationAt }, contentHash: contentHash(attestation) } };
    const result = { ...scope, signature: await sign(scope, "verify-result", 0) };
    maps.set(resultAt, result);
    claims.push({ ref: `${scheme}:${identifier}`, verifiedBy: ref(resultAt, result, "verify-result", { recipeVersion: 2 }) });
    policies.push({ scheme, recipeVersion: 2, methods: ["consensus-backed-proxy"], defaultMaxAgeSec: 60,
      availability: "live", trustedResultSigners: [dids[0]] });
  }
  const listings: string[] = [];
  for (const [index, claim] of claims.entries()) {
    const scope = structuredClone(signedScope(fixture.listing, "listing"));
    scope.listingId = `identity-${index}`;
    const identity = (scope.seller as Obj).identity as Obj;
    identity.claims = [...identity.claims as Obj[], claim];
    const identityScope = { ...identity };
    delete identityScope.presentation;
    const signature = Buffer.from(await ed25519Sign(Buffer.from(`dacs-bundle-presentation:v1:${contentHash(identityScope)}`), privateKeyFromSeed(seeds[1]))).toString("hex");
    identity.presentation = { kind: "per-claim", signatures: [{ ref: dids[1], signature }] };
    const at = locator(530 + index);
    maps.set(at, { ...scope, signature: await sign(scope, "listing", 1) });
    listings.push(at);
  }
  const resolve = async (scheme: string, version: number) => policies.find((p) => p.scheme === scheme && p.recipeVersion === version) ?? null;
  assert.equal((await indexFixture(fixture, { listingAnchors: [listings[0]] }, resolve)).identityTier, "verified");
  assert.equal((await indexFixture(fixture, { listingAnchors: [listings[1]] }, resolve)).identityTier, "institutional");
  for (const listingAnchors of [listings, [...listings].reverse()]) {
    const record = await indexFixture(fixture, { listingAnchors }, resolve);
    assert.equal(record.listings.length, 2);
    assert.equal(record.identityTier, "institutional");
  }
});

test("a readable invalid owner marker differs from an unavailable owner marker", async () => {
  const fixture = await vector("marker-output", 600);
  const scope = signedScope(fixture.listing, "listing");
  scope.listingId = "owner-marker-output";
  fixture.listing = { ...scope, signature: await sign(scope, "listing", 1) };
  maps.set(fixture.locators.listing, fixture.listing);
  const markerAt = locator(610);
  admitRevocationCandidates(artifactHash(fixture.listing, "listing"), [{ locator: markerAt,
    owner: `0x${dids[1].slice(-64)}`, contentHash: "c".repeat(64) }]);
  assert.equal((await indexFixture(fixture)).listings.length, 0, "unreadable owner evidence is indeterminate");
  maps.set(markerAt, { revocationVersion: "1", signature: "invalid" });
  const record = await indexFixture(fixture);
  assert.equal(record.listings.length, 1, "a readable rejected candidate does not withhold an active listing");
  assert.equal(record.listings[0].status, "active");
});

test("seller format probes route both signed current discriminators without retrying legacy", async () => {
  for (const fault of [false, true]) for (const malformed of [false, true]) {
    const fixture = await vector(`format-probe-${fault}-${malformed}`, 620);
    const scope = signedScope(fixture.sellerBundle, "bundle");
    if (fault) {
      delete scope.bundleVersion;
      scope.faultBundleVersion = "1";
      scope.faultedParty = "none";
    }
    if (malformed) scope.phaseSummary = [{ index: 2, kind: "settle", outcome: "banana" }];
    maps.set(fixture.locators.seller, { ...scope,
      signatures: [await sign(scope, "bundle", 0, true), await sign(scope, "bundle", 1, true)], anchoredByRole: "seller" });
    const reads = new Map<string, number>();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const at = String(input).split("/").pop() ?? "";
      const count = (reads.get(at) ?? 0) + 1;
      reads.set(at, count);
      const data = at === fixture.locators.buyer && count === 1 ? null : maps.get(at);
      return data ? Response.json({ success: true, owner: `0x${dids[1].slice(-64)}`, programName: "dacs:test", data })
        : new Response(null, { status: 503 });
    };
    try {
      const deal = registeredDeal(`format-probe-${fault}-${malformed}`, fixture.locators.buyer, fixture.locators.seller);
      const record = await indexRegistration({ primaryClaim: dids[1], displayName: "Seller",
        listingAnchors: [fixture.locators.listing], deals: [deal] }, undefined, async () => ({}));
      assert.equal(reads.get(fixture.locators.buyer), 1, "no legacy root retry after the seller probe");
      assert.equal(reads.get(fixture.locators.seller), 1);
      assert.equal(record.deals.length, 1);
      assert.equal(record.deals[0].signatureVerified, false);
      assert.equal(record.deals[0].refsVerified, false);
      assert.equal(record.deals[0].reputationEligible, false);
      assert.equal(record.deals[0].outcome, undefined);
      assert.equal(record.deals[0].anchoredByRole, undefined);
      assert.equal(record.reputation.bundleCount, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test("a verified current abort without an agreement reports an unknown rail", async () => {
  for (const withPayment of [false, true]) {
    const fixture = await vector("no-agreement-abort", 640);
    const bindings: BundleBinding[] = [];
    for (const [role, raw, at] of [["buyer", fixture.buyerBundle, fixture.locators.buyer],
      ["seller", fixture.sellerBundle, fixture.locators.seller]] as const) {
      const scope = signedScope(raw, "bundle");
      delete scope.agreementRef;
      scope.outcome = role === "seller" ? "aborted-by-other" : "aborted-by-self";
      // Without payment evidence the bundle signs no successful payment phase.
      if (!withPayment) {
        scope.settlementEvidence = [];
        scope.phaseSummary = [];
      }
      const bundle = { ...scope, signatures: [await sign(scope, "bundle", 0, true), await sign(scope, "bundle", 1, true)], anchoredByRole: role };
      maps.set(at, bundle);
      bindings.push(await bindingFor("no-agreement-abort", role, at, bundle, role === "buyer" ? 0 : 1));
    }
    const deal = registeredDeal("no-agreement-abort", fixture.locators.buyer, fixture.locators.seller);
    const record = await indexFixture(fixture, { deals: [deal], bundleBindings: bindings });
    assert.equal(record.deals.length, 1);
    assert.equal(record.deals[0].signatureVerified, true);
    assert.equal(record.deals[0].refsVerified, true);
    // Success payment evidence with no agreement rail has no SB-1 projection, so it is not counted.
    assert.equal(record.deals[0].reputationEligible, !withPayment, String(withPayment));
    assert.equal(record.deals[0].sellerOutcome, "aborted-by-other");
    assert.equal(record.deals[0].rail, "unknown");
    assert.equal(record.deals[0].agreementPrice, undefined);
  }
});

test("indexRegistration projects authenticated orchestrator faults and neutral listing hints", async () => {
  const fixture = await vector("01QRCHESTRAT0RQVTPVT00000Q", 660);
  const bindings: BundleBinding[] = [];
  for (const [role, raw, at] of [["buyer", fixture.buyerBundle, fixture.locators.buyer],
    ["seller", fixture.sellerBundle, fixture.locators.seller]] as const) {
    const scope = signedScope(raw, "bundle");
    delete scope.bundleVersion;
    Object.assign(scope, { faultBundleVersion: "1", faultedParty: "orchestrator", outcome: "failed-counterparty" });
    scope.parties = [...scope.parties as Obj[], { role: "orchestrator", primaryClaim: dids[2], bundleHash: "c".repeat(64) }];
    const bundle = { ...scope, signatures: await Promise.all([0, 1, 2].map((n) => sign(scope, "bundle", n, true))), anchoredByRole: role };
    maps.set(at, bundle);
    bindings.push(await bindingFor("01QRCHESTRAT0RQVTPVT00000Q", role, at, bundle, role === "buyer" ? 0 : 1));
  }
  const deal = registeredDeal("01QRCHESTRAT0RQVTPVT00000Q", fixture.locators.buyer, fixture.locators.seller);
  const record = await indexFixture(fixture, { deals: [deal], bundleBindings: bindings });
  assert.equal(record.deals[0].refsVerified, true);
  assert.equal(record.deals[0].reputationEligible, true);
  assert.equal(record.deals[0].faultedParty, "orchestrator");
  assert.equal(record.reputation.bundleCount, 1);
  assert.equal(record.reputation.completionRate, null);
  assert.equal(record.reputation.counterpartyFaultRate, null);
  assert.equal(record.listings[0].reputationHint!.bundleCount, 1);
  assert.equal(record.listings[0].reputationHint!.completionRate, null);
});
