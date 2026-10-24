import assert from "node:assert/strict";
import test from "node:test";
// First: the store must open in a fresh directory, never the checkout's data/.
import { isolatedDataDir } from "./fixtures/isolated-data-dir.js";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { artifactHash, buildCurrentEvidenceGraph, signedScope, verifiedDiscoveryAgreement } from "../src/catalog/evidenceGraph.js";
import { agreementRail } from "../src/catalog/agreementMetadata.js";
import { currentBundleCopiesDiverge, reconcileCurrentCopies } from "../src/catalog/currentReconciliation.js";
import { deriveIdentityTier, type RecipePolicy } from "../src/catalog/identityVerification.js";
import {
  indexRegistration,
  listingBindingRejection,
} from "../src/catalog/indexer.js";
import { deriveSellerReputation, isNeutralCancellation } from "../src/catalog/reputation.js";
import { verifyListing } from "../src/catalog/listingVerification.js";
import { boundedBundleBindings, logicalBundleAddress } from "../src/catalog/bundleBinding.js";
import { DATA_DIR, loadScanState, saveScanState } from "../src/catalog/store.js";
import type { DealRecord, RegisteredDeal } from "../src/catalog/types.js";

import { type Obj, seeds, dids, locator, maps, sign, ref, vector, bindingFor, installAgreement,
  payeeBoundVector, graphAt, registeredDeal } from "./fixtures/current-evidence.js";

test("the catalog store opens in this run's own directory", () => {
  // Revocation-candidate rows persist; a shared data/ made the owner-marker
  // test below pass only on the first run in a checkout.
  assert.equal(DATA_DIR, isolatedDataDir);
});

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
  assert.equal(agreementRail(agreement), "pay-dem");
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

test("current evidence graph verifies payee-bound agreements under their distinct domain", async () => {
  const fixture = await payeeBoundVector();
  assert.ok(await verifyListing(fixture.listing), "payee-bound commitment listing must verify");
  const graph = await graphAt(fixture.locators.buyer, fixture.listing, fixture.locators.listing);
  assert.equal(graph.ok, true, graph.reason);
  assert.equal(graph.agreement?.payeeBoundAgreementVersion, "1");
  assert.equal(graph.agreement?.agreementVersion, undefined);
});

test("current evidence graph verifies v0.3 FaultAttestationBundle attribution and domain", async () => {
  const fixture = await vector("fault-bundle-job", 20);
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
        (scope.terms as Obj).payoutBindings = [{ railId: "pay-x402", phaseIndex: 2, payeeAddress: dids[1] }];
      },
    },
    {
      name: "duplicate payout key",
      mutate: (scope) => {
        const binding = { railId: "pay-dem", phaseIndex: 2, payeeAddress: dids[1] };
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
    { railId: "pay-dem", phaseIndex: 2, payeeAddress: dids[1] },
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
  assert.equal(fallback.refsVerified, false, "#255 requires authoritative absence before one-copy attribution");
  assert.equal(fallback.selectedLocator, fallbackFixture.locators.buyer);
  const reputation = deriveSellerReputation([dealRecord(fallbackDeal, fallback)], 0, 200);
  assert.equal(reputation.bundleCount, 0);
  assert.deepEqual(reputation.bundleRefs, []);
});

test("indexer resolves current copies through BundleBindings rather than submitted native pointers", async () => {
  const fixture = await vector("binding-resolved-job", 70);
  const submittedBuyerPointer = locator(998);
  const submittedSellerPointer = locator(999);
  const deal = registeredDeal("binding-resolved-job", submittedBuyerPointer, submittedSellerPointer);
  const bundleBindings = [
    await bindingFor(deal.jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
    await bindingFor(deal.jobId, "seller", fixture.locators.seller, fixture.sellerBundle, 1),
  ];
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
    assert.equal(record.deals[0].rail, "pay-dem");
    assert.equal(record.reputation.bundleCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function indexSellerDeal(presentedBy: string, jobId: string, offset: number) {
  const fixture = await vector(jobId, offset, presentedBy);
  const deal = registeredDeal(jobId, locator(offset + 98), locator(offset + 99));
  const bundleBindings = [
    await bindingFor(deal.jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
    await bindingFor(deal.jobId, "seller", fixture.locators.seller, fixture.sellerBundle, 1),
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const data = maps.get(String(input).split("/").pop() ?? "");
    return new Response(JSON.stringify(data
      ? { success: true, owner: `0x${dids[1].slice(-64)}`, programName: "dacs:test", data }
      : { success: false }), { status: data ? 200 : 404, headers: { "content-type": "application/json" } });
  };
  try {
    return await indexRegistration({ primaryClaim: dids[1], displayName: "seller",
      listingAnchors: [fixture.locators.listing], deals: [deal], bundleBindings },
    undefined, async () => { throw new Error("identity unavailable"); });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("a Listing presented by an unqualified claim is summarised", async () => {
  const record = await indexSellerDeal(dids[1], "unqualified-job", 100);
  assert.equal(record.listings.length, 1);
  assert.equal(record.deals[0].refsVerified, true);
});

test("a Listing presented by a qualified claim is summarised under the exact presentedBy and backs its deal evidence", async () => {
  const record = await indexSellerDeal(`${dids[1]}?channel=directory`, "qualified-job", 110);
  assert.deepEqual(record.listings.map((listing) => listing.seller.primaryClaim), [`${dids[1]}?channel=directory`]);
  assert.equal(record.deals[0].refsVerified, true);
});

test("a deal's evidence graph refuses a referenced Listing the SDK reader no longer admits", async () => {
  // DPA-1: an attested-payload deliverable without a verification method. Historical reads use the same gate;
  // only an explicit DACS_HISTORICAL_LISTING_IMPORTS pin re-admits an older signature encoding.
  const fixture = await vector("dpa-1-job", 130, dids[1], { kind: "attested-payload", payloadFormat: "application/json" });
  assert.equal(await verifyListing(fixture.listing), null);
  const graph = await graphAt(fixture.locators.buyer, fixture.listing, fixture.locators.listing);
  assert.equal(graph.ok, false);
  assert.match(String(graph.reason), /listing/i);
});

test("bindings signed by other parties leave a deal's binding resolution intact", async () => {
  const fixture = await vector("crowded-binding-job", 90);
  const deal = registeredDeal("crowded-binding-job", locator(996), locator(997));
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
    return new Response(JSON.stringify(data ? { success: true, owner: `0x${dids[1].slice(-64)}`, programName: "dacs:test", data } : { success: false }),
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

test("registration-time holder binding overflow leaves the buyer side indeterminate", async () => {
  const fixture = await vector("registration-binding-overflow-job", 140);
  const deal = registeredDeal("registration-binding-overflow-job", fixture.locators.buyer, fixture.locators.seller);
  const { signature: _signature, ...buyerScope } = await bindingFor(deal.jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0);
  // Distinct signed records share one native address, keeping BB-6's separate
  // fetch budget from masking the registration-time binding cap.
  const buyers = await Promise.all(Array.from({ length: 33 }, async (_, index) => {
    const scope = { ...buyerScope, anchorTx: `tx-registration-binding-${index}` };
    const value = Buffer.from(await ed25519Sign(Buffer.from(`dacs-bundle-binding:v1:${contentHash(scope)}`),
      privateKeyFromSeed(seeds[0]))).toString("base64url");
    return { ...scope, signature: { algorithm: "ed25519" as const, signer: dids[0], value } };
  }));
  assert.equal(new Set(buyers.map((binding) => contentHash(binding))).size, 33);
  const seller = await bindingFor(deal.jobId, "seller", fixture.locators.seller, fixture.sellerBundle, 1);
  const saved = loadScanState();
  const originalFetch = globalThis.fetch;
  saveScanState({ ...saved, bundleBindings: {}, bundleBindingOverflow: [] });
  globalThis.fetch = async (input) => {
    const data = maps.get(String(input).split("/").pop() ?? "");
    return new Response(JSON.stringify(data ? { success: true, owner: `0x${dids[1].slice(-64)}`, programName: "dacs:test", data } : { success: false }),
      { status: data ? 200 : 404, headers: { "content-type": "application/json" } });
  };
  const index = (count: number) => indexRegistration({ primaryClaim: dids[1], displayName: "seller",
    listingAnchors: [fixture.locators.listing], deals: [deal], bundleBindings: [...buyers.slice(0, count), seller] },
    undefined, async () => { throw new Error("identity unavailable"); });
  try {
    assert.equal((await index(32)).deals[0].refsVerified, true, "the full in-budget set resolves normally");
    assert.deepEqual(loadScanState().bundleBindingOverflow, [], "no persisted overflow supplies the registration-time marker");
    const record = await index(33);
    assert.equal(record.deals.length, 1);
    assert.equal(record.deals[0].refsVerified, false, "truncating the holder's bindings must leave its side indeterminate");
    assert.equal(record.reputation.bundleCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    saveScanState(saved);
  }
});

test("indexer excludes a valid current seller copy when the buyer anchor is unreadable", async () => {
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
    const deal = {
      ...registeredDeal("seller-fallback-job", fixture.locators.buyer, fixture.locators.seller),
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

test("fixed-price negotiation of a negotiable band requires the exact decimal center and currency", async () => {
  for (const profile of ["legacy", "payee-bound"] as const) {
    for (const [amount, currency, accepted] of [
      ["100.000000000000000001", "USDC", true],
      ["90", "USDC", false],
      ["100.000000000000000002", "USDC", false],
      ["100.000000000000000001", "EUR", false],
    ] as const) {
      const fixture = profile === "legacy" ? await vector() : await payeeBoundVector();
      const listingScope = signedScope(fixture.listing, "listing");
      listingScope.pricing = { kind: "negotiable", bandCenter: { amount: "100.000000000000000001", currency: "USDC" }, minPct: 20, maxPct: 20 };
      fixture.listing = { ...listingScope, signature: await sign(listingScope, "listing", 1) };
      maps.set(fixture.locators.listing, fixture.listing);
      const listingRef = { listingId: "svc", version: 1, contentHash: artifactHash(fixture.listing, "listing") };
      fixture.buyerBundle.listingRef = listingRef;
      fixture.sellerBundle.listingRef = listingRef;
      const agreementScope = signedScope(fixture.agreement, "agreement");
      agreementScope.listingRef = listingRef;
      agreementScope.terms = { ...(agreementScope.terms as Obj), price: { amount, currency } };
      await installAgreement(fixture, agreementScope);
      const graph = await graphAt(fixture.locators.buyer, fixture.listing, fixture.locators.listing);
      assert.equal(graph.ok, false, `${profile}: ${amount} ${currency}: ${graph.reason}`);
      assert.equal(graph.refsVerified, false);
      assert.match(graph.reason ?? "", accepted ? /semantic settlement verification is unsupported/ : /does not match/);
    }
  }
});

test("procurement completion remains unverified for either publisher role until role-aware reconciliation is supported", async () => {
  for (const publisherRole of ["buyer", "seller"] as const) {
    const fixture = await vector();
    const scope = signedScope(fixture.listing, "listing");
    scope.pipeline = [{ kind: "negotiate-sealed-envelope-procurement", parameters: {
      commitDeadline: 1, revealWindow: 3600, auctionMode: "procurement", selectionRule: "lowest-price",
    } }, ...(scope.pipeline as Obj[]).slice(1)];
    scope.pricing = { kind: "auction", selectionRule: "lowest-price" };
    fixture.listing = { ...scope, signature: await sign(scope, "listing", 1) };
    const listingRef = { listingId: "svc", version: 1, contentHash: artifactHash(fixture.listing, "listing") };
    const agreement = signedScope(fixture.agreement, "agreement");
    agreement.listingRef = listingRef;
    if (publisherRole === "buyer") {
      agreement.parties = [{ role: "buyer", primaryClaim: dids[1] }, { role: "seller", primaryClaim: dids[0] }];
      for (const bundle of [fixture.buyerBundle, fixture.sellerBundle]) {
        bundle.parties = (bundle.parties as Obj[]).map(party => ({ ...party, role: party.role === "buyer" ? "seller" : "buyer" }));
      }
    }
    fixture.buyerBundle.listingRef = listingRef;
    fixture.sellerBundle.listingRef = listingRef;
    await installAgreement(fixture, agreement);
    assert.equal(await verifyListing(fixture.listing), null, publisherRole);
    const graph = await graphAt(fixture.locators.buyer, fixture.listing, fixture.locators.listing);
    assert.equal(graph.ok, false, publisherRole);
    assert.equal(graph.refsVerified, false, publisherRole);
  }
});

test("fixed-price agreements require a declared matching pattern for both pricing kinds and agreement profiles", async () => {
  for (const profile of ["legacy", "payee-bound"] as const) {
    for (const pricingKind of ["negotiable", "fixed"] as const) {
      for (const pattern of [undefined, null, 7, {}, "", "fixed_price", "rfq", "sealed-envelope", "fixed-price"]) {
        const fixture = profile === "legacy" ? await vector() : await payeeBoundVector();
        if (pricingKind === "negotiable") {
          const listingScope = signedScope(fixture.listing, "listing");
          listingScope.pricing = { kind: "negotiable", bandCenter: { amount: "1.25", currency: "DEM" }, minPct: 20, maxPct: 20 };
          fixture.listing = { ...listingScope, signature: await sign(listingScope, "listing", 1) };
          maps.set(fixture.locators.listing, fixture.listing);
        }
        const listingRef = { listingId: "svc", version: 1, contentHash: artifactHash(fixture.listing, "listing") };
        fixture.buyerBundle.listingRef = listingRef;
        fixture.sellerBundle.listingRef = listingRef;
        const agreementScope = signedScope(fixture.agreement, "agreement");
        agreementScope.listingRef = listingRef;
        if (pattern === undefined) delete agreementScope.derivedFromPattern;
        else agreementScope.derivedFromPattern = pattern;
        // Re-sign the agreement and both bundle references: rejection must be semantic.
        await installAgreement(fixture, agreementScope);
        for (const role of ["buyer", "seller"] as const) {
          const graph = await graphAt(fixture.locators[role], fixture.listing, fixture.locators.listing);
          const accepted = pattern === "fixed-price" && pricingKind === "fixed";
          const label = `${profile}/${pricingKind}/${role}/${JSON.stringify(pattern)}: ${graph.reason}`;
          assert.equal(graph.signaturesVerified, true, label);
          assert.equal(graph.ok, accepted, label);
          assert.equal(graph.refsVerified, accepted, label);
        }
      }
    }
  }
});

test("agreement discovery requires a recognized pattern in both agreement profiles", async () => {
  for (const profile of ["legacy", "payee-bound"] as const) {
    for (const pattern of [undefined, null, 7, {}, "", "fixed_price", "fixed-price", "rfq", "sealed-envelope"]) {
      const fixture = profile === "legacy" ? await vector() : await payeeBoundVector();
      const scope = signedScope(fixture.agreement, "agreement");
      if (pattern === undefined) delete scope.derivedFromPattern;
      else scope.derivedFromPattern = pattern;
      await installAgreement(fixture, scope);
      assert.equal(await verifiedDiscoveryAgreement(fixture.agreement),
        typeof pattern === "string" && ["fixed-price", "rfq", "sealed-envelope"].includes(pattern),
        `${profile}/${JSON.stringify(pattern)}`);
    }
  }
});

test("agreement patterns must match RFQ and sealed-envelope pipelines in both agreement profiles", async () => {
  for (const profile of ["legacy", "payee-bound"] as const) {
    for (const pattern of ["rfq", "sealed-envelope"] as const) {
      for (const declared of [pattern, "fixed-price"]) {
        const fixture = profile === "legacy" ? await vector() : await payeeBoundVector();
        const listingScope = signedScope(fixture.listing, "listing");
        (listingScope.pipeline as Obj[])[0] = pattern === "rfq"
          ? { kind: "negotiate-rfq", parameters: { maxTurns: 6, timeoutSec: 300 } }
          : { kind: "negotiate-sealed-envelope", parameters: { commitDeadline: 1, revealWindow: 3600, selectionRule: "lowest-price", fixedPriceFallback: true } };
        listingScope.pricing = pattern === "rfq"
          ? { kind: "negotiable", bandCenter: { amount: "1.25", currency: "DEM" }, minPct: 20, maxPct: 20 }
          : { kind: "auction", selectionRule: "lowest-price" };
        fixture.listing = { ...listingScope, signature: await sign(listingScope, "listing", 1) };
        maps.set(fixture.locators.listing, fixture.listing);
        assert.ok(await verifyListing(fixture.listing));
        const listingRef = { listingId: "svc", version: 1, contentHash: artifactHash(fixture.listing, "listing") };
        fixture.buyerBundle.listingRef = listingRef;
        fixture.sellerBundle.listingRef = listingRef;
        const agreementScope = signedScope(fixture.agreement, "agreement");
        agreementScope.listingRef = listingRef;
        agreementScope.derivedFromPattern = declared;
        await installAgreement(fixture, agreementScope);
        for (const role of ["buyer", "seller"] as const) {
          const graph = await graphAt(fixture.locators[role], fixture.listing, fixture.locators.listing);
          const label = `${profile}/${role}/${pattern}/${declared}: ${graph.reason}`;
          assert.equal(graph.ok, declared === pattern, label);
          assert.equal(graph.refsVerified, declared === pattern, label);
        }
      }
    }
  }
});

test("RFQ fixed-price fallback remains discoverable but requires semantic settlement adapters", async () => {
  for (const profile of ["legacy", "payee-bound"] as const) {
    const fixture = profile === "legacy" ? await vector() : await payeeBoundVector();
    const listingScope = signedScope(fixture.listing, "listing");
    (listingScope.pipeline as Obj[])[0] = {
      kind: "negotiate-rfq", parameters: { maxTurns: 6, timeoutSec: 300, fixedPriceFallback: true },
    };
    listingScope.pricing = { kind: "negotiable", bandCenter: { amount: "1.25", currency: "DEM" }, minPct: 20, maxPct: 20 };
    fixture.listing = { ...listingScope, signature: await sign(listingScope, "listing", 1) };
    maps.set(fixture.locators.listing, fixture.listing);
    assert.ok(await verifyListing(fixture.listing));
    const listingRef = { listingId: "svc", version: 1, contentHash: artifactHash(fixture.listing, "listing") };
    fixture.buyerBundle.listingRef = listingRef;
    fixture.sellerBundle.listingRef = listingRef;
    const agreementScope = signedScope(fixture.agreement, "agreement");
    agreementScope.listingRef = listingRef;
    agreementScope.derivedFromPattern = "fixed-price";
    await installAgreement(fixture, agreementScope);
    for (const role of ["buyer", "seller"] as const) {
      const graph = await graphAt(fixture.locators[role], fixture.listing, fixture.locators.listing);
      const label = `${profile}/${role}: ${graph.reason}`;
      assert.equal(graph.signaturesVerified, true, label);
      assert.equal(graph.ok, false, label);
      assert.match(graph.reason ?? "", /semantic settlement verification is unsupported/, label);
      assert.equal(graph.refsVerified, false, label);
    }
  }
});

test("RFQ fallback requires signed opt-in and the exact decimal center without restricting normal RFQ agreements", async () => {
  for (const profile of ["legacy", "payee-bound"] as const) {
    for (const [fallback, pattern, amount, currency, accepted] of [
      [true, "fixed-price", "100.000000000000000001", "USDC", true],
      [false, "fixed-price", "100.000000000000000001", "USDC", false],
      [undefined, "fixed-price", "100.000000000000000001", "USDC", false],
      [true, "fixed-price", "90", "USDC", false],
      [true, "fixed-price", "100.000000000000000002", "USDC", false],
      [true, "fixed-price", "100.000000000000000001", "EUR", false],
      [true, "sealed-envelope", "100.000000000000000001", "USDC", false],
      [true, "rfq", "90", "USDC", true],
      [false, "rfq", "90", "USDC", true],
      [undefined, "rfq", "90", "USDC", true],
    ] as const) {
      const fixture = profile === "legacy" ? await vector() : await payeeBoundVector();
      const listingScope = signedScope(fixture.listing, "listing");
      const parameters: Obj = { maxTurns: 6, timeoutSec: 300 };
      if (fallback !== undefined) parameters.fixedPriceFallback = fallback;
      (listingScope.pipeline as Obj[])[0] = { kind: "negotiate-rfq", parameters };
      listingScope.pricing = { kind: "negotiable", bandCenter: { amount: "100.000000000000000001", currency: "USDC" }, minPct: 20, maxPct: 20 };
      fixture.listing = { ...listingScope, signature: await sign(listingScope, "listing", 1) };
      maps.set(fixture.locators.listing, fixture.listing);
      assert.ok(await verifyListing(fixture.listing));
      const listingRef = { listingId: "svc", version: 1, contentHash: artifactHash(fixture.listing, "listing") };
      fixture.buyerBundle.listingRef = listingRef;
      fixture.sellerBundle.listingRef = listingRef;
      const agreementScope = signedScope(fixture.agreement, "agreement");
      agreementScope.listingRef = listingRef;
      agreementScope.derivedFromPattern = pattern;
      agreementScope.terms = { ...(agreementScope.terms as Obj), price: { amount, currency } };
      // Every case has valid signatures and updated references, including rejections.
      await installAgreement(fixture, agreementScope);
      for (const role of ["buyer", "seller"] as const) {
        const graph = await graphAt(fixture.locators[role], fixture.listing, fixture.locators.listing);
        const label = `${profile}/${role}/${fallback}/${pattern}/${amount} ${currency}: ${graph.reason}`;
        assert.equal(graph.signaturesVerified, true, label);
        assert.equal(graph.ok, accepted && pattern === "rfq", label);
        assert.equal(graph.refsVerified, accepted && pattern === "rfq", label);
        if (accepted && pattern === "fixed-price") assert.match(graph.reason ?? "", /semantic settlement verification is unsupported/, label);
        if (!accepted) assert.match(graph.reason ?? "", /does not match/, label);
      }
    }
  }
});

test("RFQ fixed-price fallback cannot select a center from metered pricing", async () => {
  for (const profile of ["legacy", "payee-bound"] as const) {
    for (const pattern of ["fixed-price", "rfq"] as const) {
      const fixture = profile === "legacy" ? await vector() : await payeeBoundVector();
      const listingScope = signedScope(fixture.listing, "listing");
      (listingScope.pipeline as Obj[])[0] = {
        kind: "negotiate-rfq", parameters: { maxTurns: 6, timeoutSec: 300, fixedPriceFallback: true },
      };
      listingScope.pricing = { kind: "metered", unitPrice: { amount: "1.25", currency: "DEM" }, unit: "call" };
      fixture.listing = { ...listingScope, signature: await sign(listingScope, "listing", 1) };
      maps.set(fixture.locators.listing, fixture.listing);
      assert.ok(await verifyListing(fixture.listing));
      const listingRef = { listingId: "svc", version: 1, contentHash: artifactHash(fixture.listing, "listing") };
      fixture.buyerBundle.listingRef = listingRef;
      fixture.sellerBundle.listingRef = listingRef;
      const agreementScope = signedScope(fixture.agreement, "agreement");
      agreementScope.listingRef = listingRef;
      agreementScope.derivedFromPattern = pattern;
      await installAgreement(fixture, agreementScope);
      for (const role of ["buyer", "seller"] as const) {
        const graph = await graphAt(fixture.locators[role], fixture.listing, fixture.locators.listing);
        const label = `${profile}/${role}/${pattern}: ${graph.reason}`;
        assert.equal(graph.signaturesVerified, true, label);
        assert.equal(graph.ok, pattern === "rfq", label);
        assert.equal(graph.refsVerified, pattern === "rfq", label);
      }
    }
  }
});

test("authenticated indeterminate withdrawal hides discovery but retains a committed completed deal", async t => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const { activeOffer } = await import("../src/catalog/discovery.js");
  const { findValidListingRevocation } = await import("../src/catalog/listingVerification.js");
  const { recordWellKnownWithdrawalCheck, retainListingRevocation } = await import("../src/catalog/store.js");
  const fixture = await vector("withdrawal-history-job", 800);
  const scope = signedScope(fixture.listing, "listing");
  scope.acceptedRails = [{ railId: "demos-native:DEM" }];
  scope.pipeline = (scope.pipeline as Obj[]).map(phase => phase.kind === "pay-dem"
    ? { ...phase, parameters: { rail: "demos-native:DEM" } } : phase);
  fixture.listing = { ...scope, signature: await sign(scope, "listing", 1) };
  maps.set(fixture.locators.listing, fixture.listing);
  const listingRef = { listingId: "svc", version: 1, contentHash: artifactHash(fixture.listing, "listing") };
  for (const bundle of [fixture.buyerBundle, fixture.sellerBundle]) bundle.listingRef = listingRef;
  const agreementScope = signedScope(fixture.agreement, "agreement");
  agreementScope.listingRef = listingRef;
  agreementScope.terms = { ...(agreementScope.terms as Obj), rail: { railId: "demos-native:DEM" } };
  await installAgreement(fixture, agreementScope);
  const deal = registeredDeal("withdrawal-history-job", locator(990), locator(991));
  const reg = {
    primaryClaim: dids[1], displayName: "seller", listingAnchors: [fixture.locators.listing], deals: [deal],
    bundleBindings: [
      await bindingFor(deal.jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
      await bindingFor(deal.jobId, "seller", fixture.locators.seller, fixture.sellerBundle, 1),
    ],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const data = maps.get(String(input).split("/").pop() ?? "");
    return data ? Response.json({ success: true, owner: `0x${dids[1].slice(-64)}`, data })
      : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
  };
  try {
    const resolve = async () => { throw new Error("identity unavailable"); };
    const before = await indexRegistration(reg, undefined, resolve);
    assert.equal(before.listings.some(activeOffer), true, "canonical rail makes the control discoverable");
    assert.equal(before.deals[0].refsVerified, true);
    assert.equal(before.deals[0].buyerBundleRef, fixture.locators.buyer);
    assert.equal(before.deals[0].sellerBundleRef, fixture.locators.seller);
    assert.equal(before.reputation.completed, 1);
    assert.equal(before.reputation.bundleCount, 1);
    recordWellKnownWithdrawalCheck("https://history.example", dids[1], [listingRef.contentHash],
      [listingRef.contentHash], { generatedAt: 1, hash: "c".repeat(64) }, [], "publisher-signature");
    const held = await indexRegistration(reg, before, resolve);
    assert.deepEqual(held.listings, [], "authenticated incomplete withdrawal suppresses new discovery");
    assert.equal(held.deals[0].refsVerified, true, "historical listing remains available to the evidence graph");
    assert.deepEqual(held.reputation, before.reputation, "committed completion and reputation are unchanged");

    const verified = await verifyListing(fixture.listing); assert.ok(verified);
    const markerScope = { listingId: "svc", listingVersion: 1, listingContentHash: listingRef.contentHash, revokedAt: 1 };
    const marker = { ...markerScope, signature: { algorithm: "ed25519", signer: dids[1],
      value: Buffer.from(await ed25519Sign(Buffer.from(`dacs-revocation:v1:${contentHash(markerScope)}`),
        privateKeyFromSeed(seeds[1]))).toString("base64url") } };
    const binding = await findValidListingRevocation([locator(807)], verified, 1, async () => marker);
    assert.ok(binding); retainListingRevocation(binding, marker);
    const revoked = await indexRegistration(reg, held, resolve);
    assert.equal(revoked.listings.some(activeOffer), false);
    assert.equal(revoked.listings[0].status, "revoked");
    assert.deepEqual(revoked.listings[0].revocation, binding);
    assert.equal(revoked.deals[0].refsVerified, true);
    assert.deepEqual(revoked.reputation, before.reputation, "verified revocation preserves committed history too");
  } finally { globalThis.fetch = originalFetch; }
});


test("new negotiable fixed-price pairings stay discoverable but cannot establish completion or volume", async () => {
  for (const profile of ["legacy", "payee-bound"] as const) {
    for (const negotiation of ["negotiate-fixed-price", "negotiate-rfq"] as const) {
      for (const faultBundle of [false, true]) for (const fault of ["missing-deliverable", "mismatched-deliverable", "usdc-pay-dem", "nonexistent-transaction", "missing-delivery", "missing-invocations"] as const) {
        const fixture = profile === "legacy" ? await vector() : await payeeBoundVector();
        const scope = signedScope(fixture.listing, "listing");
        const currency = fault === "usdc-pay-dem" ? "USDC" : "DEM";
        scope.pricing = { kind: "negotiable", bandCenter: { amount: "1.25", currency }, minPct: 20, maxPct: 20 };
        (scope.pipeline as Obj[])[0] = negotiation === "negotiate-rfq"
          ? { kind: negotiation, parameters: { maxTurns: 6, timeoutSec: 300, fixedPriceFallback: true } }
          : { kind: negotiation };
        fixture.listing = { ...scope, signature: await sign(scope, "listing", 1) };
        maps.set(fixture.locators.listing, fixture.listing);
        assert.ok(await verifyListing(fixture.listing), "listing remains readable for discovery");
        const listingRef = { listingId: "svc", version: 1, contentHash: artifactHash(fixture.listing, "listing") };
        const agreement = signedScope(fixture.agreement, "agreement");
        agreement.listingRef = listingRef;
        agreement.terms = { ...(agreement.terms as Obj), price: { amount: "1.25", currency },
          ...(fault === "missing-deliverable" ? {} : { deliverable: {
            kind: "attested-payload", specHash: fault === "mismatched-deliverable" ? "f".repeat(64)
              : contentHash((scope.offering as Obj).deliverable as Obj),
          } }) };
        for (const bundle of [fixture.buyerBundle, fixture.sellerBundle]) {
          bundle.listingRef = listingRef;
          if (fault !== "missing-invocations") bundle.phaseSummary = (scope.pipeline as Obj[]).map((phase, index) => ({ index, kind: phase.kind, outcome: "ok" }));
        }
        if (fault === "nonexistent-transaction") {
          const evidence = signedScope(fixture.evidence, "evidence");
          evidence.paymentTxRefs = [{ txId: "0".repeat(64), blockHash: "0".repeat(64), blockNumber: 1 }];
          const signed = { ...evidence, signature: await sign(evidence, "evidence", 1) };
          maps.set(fixture.locators.evidence, signed);
          for (const bundle of [fixture.buyerBundle, fixture.sellerBundle]) bundle.settlementEvidence = [ref(fixture.locators.evidence, signed, "evidence")];
        }
        await installAgreement(fixture, agreement);
        if (faultBundle) for (const role of ["buyer", "seller"] as const) {
          const bundle = signedScope(role === "buyer" ? fixture.buyerBundle : fixture.sellerBundle, "bundle");
          delete bundle.bundleVersion;
          bundle.faultBundleVersion = "1";
          bundle.faultedParty = "none";
          const signed = { ...bundle, signatures: [await sign(bundle, "bundle", 0, true), await sign(bundle, "bundle", 1, true)], anchoredByRole: role };
          maps.set(fixture.locators[role], signed);
          if (role === "buyer") fixture.buyerBundle = signed;
          else fixture.sellerBundle = signed;
        }
        const buyer = await graphAt(fixture.locators.buyer, fixture.listing, fixture.locators.listing);
        const seller = await graphAt(fixture.locators.seller, fixture.listing, fixture.locators.listing);
        const label = `${profile}/${negotiation}/${faultBundle ? "fault" : "legacy"}/${fault}`;
        assert.equal(buyer.signaturesVerified, true, label);
        assert.equal(seller.signaturesVerified, true, label);
        assert.equal(buyer.refsVerified, false, label);
        assert.equal(seller.refsVerified, false, label);
        const deal = registeredDeal(String(fixture.buyerBundle.jobId), fixture.locators.buyer, fixture.locators.seller);
        assert.equal(reconcileCurrentCopies(deal, dids[1], buyer, seller).refsVerified, false, label);
        const bindings = [await bindingFor(deal.jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
          await bindingFor(deal.jobId, "seller", fixture.locators.seller, fixture.sellerBundle, 1)];
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (input) => {
          const data = maps.get(String(input).split("/").pop() ?? "");
          return Response.json(data ? { success: true, owner: `0x${dids[1].slice(-64)}`, data } : { success: false }, { status: data ? 200 : 404 });
        };
        try {
          const indexed = await indexRegistration({ primaryClaim: dids[1], displayName: "seller", listingAnchors: [fixture.locators.listing],
            deals: [deal], bundleBindings: bindings }, undefined, async () => { throw new Error("identity unavailable"); });
          assert.equal(indexed.listings.length, 1, label);
          assert.equal(indexed.deals[0].refsVerified, false, label);
          assert.equal(indexed.deals[0].reputationEligible, false, label);
          assert.equal(indexed.reputation.completed, 0, label);
          assert.equal(indexed.reputation.bundleCount, 0, label);
          assert.deepEqual(indexed.reputation.observedTransactionalVolume, [], label);
        } finally { globalThis.fetch = originalFetch; }
      }
    }
  }
});

test("pre-upgrade hex listing remains readable at its pinned anchor in a completed session", async (t) => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const fixture = await vector("historical-hex-session", 900);
  const envelope = fixture.listing.signature as Obj;
  const hex = { ...fixture.listing, signature: { ...envelope,
    value: Buffer.from(String(envelope.value), "base64url").toString("hex") } };
  const hash = artifactHash(hex, "listing");
  assert.equal(hash, artifactHash(fixture.listing, "listing"), "no signed bytes or pinned hash change");
  assert.equal(await verifyListing(hex), null, "new admission retains strict SIG-6 encoding");
  const previous = process.env.DACS_HISTORICAL_LISTING_IMPORTS;
  process.env.DACS_HISTORICAL_LISTING_IMPORTS = JSON.stringify({ [fixture.locators.listing]: {
    encoding: "lowercase-hex", sellerPrimaryClaim: dids[1], listingId: "svc", listingVersion: 1, contentHash: hash,
  } });
  const originalFetch = globalThis.fetch;
  maps.set(fixture.locators.listing, hex);
  globalThis.fetch = async (input) => {
    const at = String(input).split("/").pop()!;
    const data = maps.get(at);
    return data ? Response.json({ success: true, data, owner: `0x${dids[1].slice(-64)}` })
      : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
  };
  try {
    const graph = await graphAt(fixture.locators.buyer, hex, fixture.locators.listing);
    assert.equal(graph.ok, true, graph.reason);
    assert.equal(graph.refsVerified, true);
    const deal = registeredDeal("historical-hex-session", locator(9901), locator(9902));
    const registration = { primaryClaim: dids[1], displayName: "seller", listingAnchors: [fixture.locators.listing],
      deals: [deal], bundleBindings: [
        await bindingFor(deal.jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
        await bindingFor(deal.jobId, "seller", fixture.locators.seller, fixture.sellerBundle, 1),
      ] };
    const resolve = async () => { throw new Error("offline"); };
    const indexed = await indexRegistration(registration, undefined, resolve);
    assert.equal(indexed.deals[0].refsVerified, true, "the full indexer retains the completed session's pinned history");
    assert.equal(indexed.reputation.completed, 1);
    const repeated = await indexRegistration(registration, indexed, resolve);
    assert.deepEqual(repeated.reputation, indexed.reputation, "recrawl re-verifies the same immutable history");
    assert.equal(indexed.listings.length, 1, "history is retained by the catalog reader");
    assert.equal(indexed.listings[0].contentHash, hash);
    const { saveCatalog } = await import("../src/catalog/store.js");
    saveCatalog({ catalogVersion: "1", generatedAt: Date.now(), sellers: [indexed] });
    const { NextRequest } = await import("next/server");
    const { GET: detail } = await import("../app/api/dacs/listings/[listingId]/[version]/route.js");
    const response = await detail(new NextRequest("https://directory.example/api/dacs/listings/svc/1"),
      { params: Promise.resolve({ listingId: "svc", version: "1" }) });
    assert.equal(response.status, 200, "historical detail reads use the same import contract");
    assert.deepEqual(await response.json(), hex, "detail retains the stored envelope");
    const { GET: derive } = await import("../app/api/dacs/derive/route.js");
    const derived = await derive(new NextRequest(`https://directory.example/api/dacs/derive?claim=${dids[1]}&serviceId=svc`));
    assert.equal((await derived.json()).valid, true, "derivation rechecks history against fresh owner-bound bytes");
    assert.deepEqual(graph.listing, hex, "original stored envelope remains available as evidence");
    const tampered = { ...hex, listingId: "changed-after-signing" };
    assert.equal((await graphAt(fixture.locators.buyer, tampered, fixture.locators.listing)).ok, false);
    delete process.env.DACS_HISTORICAL_LISTING_IMPORTS;
    assert.equal((await graphAt(fixture.locators.buyer, hex, fixture.locators.listing)).ok, false,
      "an artifact cannot select its own legacy import");
    const unpinned = await indexRegistration(registration, indexed, resolve);
    assert.equal(unpinned.deals[0].refsVerified, false, "cached success cannot replace the now-missing import provenance");
    assert.equal(unpinned.reputation.completed, 0);

  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.DACS_HISTORICAL_LISTING_IMPORTS;
    else process.env.DACS_HISTORICAL_LISTING_IMPORTS = previous;
  }
});
