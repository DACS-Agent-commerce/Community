import "./helpers/isolated-directory.js";
import { authorityProof, authoritySigner, proofHash, verifyTestAuthority, fixtureRecipeSnapshot } from "./helpers/authority.js";
import { nativeNodeFixture } from "./helpers/native-node.js";
import { deliverableAnchorBinding, OPAQUE_PROGRAM_NAME, paymentAnchorBinding } from "./helpers/anchor-binding.js";
import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { canonicalize, contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { agreementListingConformance, artifactHash, buildCurrentEvidenceGraph, signedScope, verifiedDiscoveryAgreement, type EvidenceGraphDeps } from "../src/catalog/evidenceGraph.js";
import { agreementRail } from "../src/catalog/agreementMetadata.js";
import { AUTHORITY_VERIFIER_ENV, AuthorityVerifierUnavailable } from "../src/catalog/authorityVerifierConfig.js";
import { currentBundleCopiesDiverge, reconcileCurrentCopies } from "../src/catalog/currentReconciliation.js";
import { deriveIdentityTier, type RecipePolicy } from "../src/catalog/identityVerification.js";
import { indexRegistration, listingBindingRejection, MAX_PUBLISHER_LISTING_READS } from "../src/catalog/indexer.js";
import { deriveSellerReputation, isNeutralCancellation } from "../src/catalog/reputation.js";
import { verifyListing } from "../src/catalog/listingVerification.js";
import { boundedBundleBindings, logicalBundleAddress } from "../src/catalog/bundleBinding.js";
import { loadScanState, saveScanState } from "../src/catalog/store.js";
import { registrationMessage } from "../src/catalog/registrationSig.js";
import { parseRegistration } from "../src/catalog/registration.js";
import type { BundleBinding, DealRecord, RegisteredDeal } from "../src/catalog/types.js";

type Obj = Record<string, unknown>;
const seeds = [11, 12].map((byte) => Uint8Array.from(Buffer.alloc(32, byte)));
const dids = seeds.map((seed) => `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`);
/** Recipe-trusted VerifyResult signer for primary-claim proofs, distinct from both parties. */
const verifierSeed = Uint8Array.from(Buffer.alloc(32, 13));
const verifierDid = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(verifierSeed))).toString("hex")}`;
const locator = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;
/** A distinct 32-byte Demos transaction hash per job, so each fixture cites its own settlement (SB-1). */
const txHashOf = (jobId: string) => contentHash({ settlement: jobId });
const maps = new Map<string, Obj>();
const readNativeFixture = nativeNodeFixture(() => maps.values());
const paymentAnchorRecord = async (at: string) => {
  const data = maps.get(at);
  return data ? { data, programName: OPAQUE_PROGRAM_NAME, acl: { mode: "public" } } : null;
};
const sign = async (raw: Obj, kind: "listing" | "agreement" | "evidence" | "rating" | "bundle" | "verify-result" | "composite", signer: number, party = false) => {
  const hash = artifactHash(raw, kind);
  const prefixes = { listing: "dacs-listing:v1:", agreement: "dacs-agreement:v1:", evidence: "dacs-evidence:v1:", rating: "dacs-rating:v1:", bundle: "dacs-bundle:v1:", "verify-result": "dacs-verifyresult:v1:", composite: "dacs-composite:v1:" };
  const prefix = kind === "agreement" && raw.payeeBoundAgreementVersion === "1"
    ? "dacs-payee-bound-agreement:v1:"
    : kind === "bundle" && raw.faultBundleVersion === "1"
      ? "dacs-fault-bundle:v1:"
      : prefixes[kind];
  const value = Buffer.from(await ed25519Sign(Buffer.from(prefix + hash), privateKeyFromSeed(seeds[signer]))).toString("base64url");
  return party ? { party: dids[signer], algorithm: "ed25519", value } : { signer: dids[signer], algorithm: "ed25519", value };
};
// §8.5.2 check 4: the agreement names the canonical DeliverableRef of the listed DeliverableSpec.
const deliverableRef = { deliverableType: "storage-program", hash: contentHash({ kind: "storage-program", accessModel: "public" }) };
const ref = (at: string, raw: Obj, kind: Parameters<typeof artifactHash>[1], extra: Obj = {}) => ({
  anchor: { kind: "storage-program", locator: at }, contentHash: artifactHash(raw, kind), ...extra,
});

async function vector(jobId = "job-1", offset = 0, sellerIndex = 1, settlementHash = txHashOf(jobId), observedAt = 100, withVet = false) {
  maps.clear();
  const buyerIndex = 1 - sellerIndex;
  const at = (n: number) => locator(offset + n);
  const listingScope: Obj = {
    dacsVersion: "1", listingVersion: 1, listingId: "svc", requiredCapabilities: ["SR-2"],
    seller: { identity: { bundleVersion: "1", presentedBy: dids[sellerIndex], presentedAt: 1, claims: [{ ref: dids[sellerIndex] }], presentation: { kind: "per-claim", signatures: [] } }, displayName: "seller" },
    offering: { title: "test", description: "test service", category: "services.test", tags: [], deliverable: { kind: "storage-program", accessModel: "public" } },
    buyerRequirement: { requirementVersion: "1", required: [], preferredPresentation: "any" },
    pipeline: [...(withVet ? [{ kind: "vet-credentials" }] : []), { kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }, { kind: "deliver-storage-program" }],
    pricing: { kind: "fixed", price: { amount: "1.25", currency: "DEM", unit: "job" } }, acceptedRails: [{ railId: "demos-native:DEM" }], terms: {}, validity: { notBefore: 1 },
  };
  // Listing verifier requires a presentation signature for the seller claim.
  const identity = (listingScope.seller as Obj).identity as Obj;
  const identityScope = { ...identity }; delete (identityScope as Obj).presentation;
  const identitySig = Buffer.from(await ed25519Sign(Buffer.from(`dacs-bundle-presentation:v1:${contentHash(identityScope)}`), privateKeyFromSeed(seeds[sellerIndex]))).toString("hex");
  (identity.presentation as Obj).signatures = [{ ref: dids[sellerIndex], signature: identitySig }];
  const listing: Obj = { ...listingScope, signature: await sign(listingScope, "listing", sellerIndex) }; maps.set(at(1), listing);
  const listingRef = { listingId: "svc", version: 1, contentHash: artifactHash(listing, "listing") };
  const agreementScope: Obj = { agreementVersion: "1", jobId, listingRef, derivedFromPattern: "fixed-price",
    parties: [{ role: "buyer", primaryClaim: dids[buyerIndex] }, { role: "seller", primaryClaim: dids[sellerIndex] }],
    terms: {
      price: { amount: "1.25", currency: "DEM" },
      rail: { railId: "demos-native:DEM" },
      deliverable: deliverableRef,
    } };
  const agreement: Obj = { ...agreementScope, signatures: [await sign(agreementScope, "agreement", buyerIndex, true), await sign(agreementScope, "agreement", sellerIndex, true)] }; maps.set(at(2), agreement);
  const evidenceScope: Obj = { evidenceVersion: "1", jobId, phase: "pay-dem", outcome: "success", paymentTxRefs: [{ kind: "demos", blockNumber: 1, txHash: settlementHash }],
    paymentAmount: { amount: "1.25", currency: "DEM" }, settlementFinality: { model: "bft-final", finalityObservedAt: 100 }, observedAt };
  const evidence: Obj = { ...evidenceScope, signature: await sign(evidenceScope, "evidence", sellerIndex) }; maps.set(at(3), evidence);
  const ratingScope: Obj = { ratingVersion: "1", jobId, rater: dids[buyerIndex], target: dids[sellerIndex], targetRole: "seller", value: 5, ratedAt: 110 };
  const rating: Obj = { ...ratingScope, signature: await sign(ratingScope, "rating", buyerIndex) }; maps.set(at(4), rating);
  const payload = { report: jobId };
  maps.set(at(61), payload);
  const deliveryScope: Obj = { evidenceVersion: "1", jobId, phase: "deliver-storage-program", outcome: "success", observedAt: 101,
    deliverableContentHash: contentHash(payload), deliverableAnchor: { kind: "storage-program", locator: at(61) } };
  const delivery = { ...deliveryScope, signature: await sign(deliveryScope, "evidence", sellerIndex) }; maps.set(at(60), delivery);
  const bundleScope: Obj = { bundleVersion: "1", jobId, outcome: "completed", listingRef,
    agreementRef: ref(at(2), agreement, "agreement"), parties: [
      { role: "buyer", bundleHash: "a".repeat(64), primaryClaim: dids[buyerIndex] },
      { role: "seller", bundleHash: "b".repeat(64), primaryClaim: dids[sellerIndex] },
    ],
    phaseSummary: (listingScope.pipeline as Obj[]).map((phase, index) => ({ index, kind: phase.kind, outcome: "ok" })), vetRecords: [],
    settlementEvidence: [ref(at(3), evidence, "evidence"), ref(at(60), delivery, "evidence")], ratingRefs: [ref(at(4), rating, "rating")],
    anchorBindings: [
      await paymentAnchorBinding(seeds[sellerIndex], jobId, "demos-native:DEM", withVet ? 3 : 2, at(3), artifactHash(evidence, "evidence")),
      await deliverableAnchorBinding(seeds[sellerIndex], jobId, at(61), contentHash(payload)),
    ],
    recipeRegistryVersion: 1, railRegistryVersion: 1, finalisedAt: 120 };
  let primaryProof: Obj | undefined;
  if (withVet) {
    // DACS-2 §7.12: the counterparty's presented primary carries its own verified claim.
    const attestation = authorityProof({ authority: "holder-key", status: "active" });
    maps.set(at(63), attestation);
    const primaryScope: Obj = { resultVersion: "1", scheme: "did", identifier: dids[buyerIndex].slice(4), recipeVersion: 1,
      method: "verifiable-credential", decision: "pass", reason: "holder key match", fetchedAt: 10, verifiedAt: 20, validUntil: 100,
      attestation: { ...ref(at(63), attestation, "attestation"), contentHash: proofHash(attestation), signer: authoritySigner } };
    const primaryResult = { ...primaryScope, signature: { signer: verifierDid, algorithm: "ed25519",
      value: Buffer.from(await ed25519Sign(Buffer.from(`dacs-verifyresult:v1:${artifactHash(primaryScope, "verify-result")}`), privateKeyFromSeed(verifierSeed))).toString("base64url") } };
    maps.set(at(62), primaryResult);
    primaryProof = ref(at(62), primaryResult, "verify-result", { recipeVersion: 1 });
    bundleScope.parties = await Promise.all([buyerIndex, sellerIndex].map(async (party, index) => {
      const scope = { bundleVersion: "1", presentedBy: dids[party], presentedAt: 1, sessionNonce: `challenge-${dids[party]}`,
        claims: [{ ref: dids[party], ...(party === buyerIndex ? { verifiedBy: primaryProof } : {}) }] };
      const signature = Buffer.from(await ed25519Sign(Buffer.from(`dacs-bundle-presentation:v1:${contentHash(scope)}`), privateKeyFromSeed(seeds[party]))).toString("hex");
      return { role: index === 0 ? "buyer" : "seller", primaryClaim: dids[party], bundleHash: contentHash(scope),
        identityBundle: { ...scope, presentation: { kind: "per-claim", signatures: [{ ref: dids[party], signature }] } } };
    }));
  }
  const signatures = [await sign(bundleScope, "bundle", buyerIndex, true), await sign(bundleScope, "bundle", sellerIndex, true)];
  const buyerBundle: Obj = { ...bundleScope, signatures, anchoredByRole: "buyer" }; maps.set(at(5), buyerBundle);
  const sellerBundle: Obj = { ...bundleScope, signatures, anchoredByRole: "seller" }; maps.set(at(6), sellerBundle);
  return {
    listing, buyerBundle, sellerBundle, agreement, evidence, rating, primaryProof,
    locators: { listing: at(1), agreement: at(2), evidence: at(3), rating: at(4), buyer: at(5), seller: at(6) },
  };
}

/** Session-vet deps: a roster recipe for the buyer's presented `did` primary, the test authority
 * and a fixture control adapter for that exact primary and result. Production installs no adapter. */
function vetDeps(primaryProof: Obj | undefined): Partial<EvidenceGraphDeps> {
  const recipes: RecipePolicy[] = [{ scheme: "did", recipeVersion: 1, methods: ["verifiable-credential"], availability: "live", defaultMaxAgeSec: 1, trustedResultSigners: [verifierDid] }];
  return {
    verifyAttestation: verifyTestAuthority,
    resolveRecipeSnapshot: async (registryVersion) => registryVersion === 1 ? { registryVersion, recipes } : null,
    verifyPrimaryClaimControl: async ({ identity, primary, result }) =>
      identity.presentedBy === dids[0] && `${primary.scheme}:${primary.identifier}` === dids[0] &&
      result.locator === (primaryProof?.anchor as Obj | undefined)?.locator,
  };
}

async function bindingFor(
  jobId: string,
  role: "buyer" | "seller",
  nativeAddress: string,
  rawBundle: Obj,
  signer: number,
): Promise<BundleBinding> {
  const scope = {
    bindingVersion: "1" as const,
    jobId,
    role,
    logicalAddress: logicalBundleAddress(jobId, role),
    nativeAddress,
    bundleContentHash: artifactHash(rawBundle, "bundle"),
    signer: dids[signer],
  };
  const value = Buffer.from(await ed25519Sign(
    Buffer.from(`dacs-bundle-binding:v1:${contentHash(scope)}`),
    privateKeyFromSeed(seeds[signer]),
  )).toString("base64url");
  return { ...scope, signature: { algorithm: "ed25519", signer: dids[signer], value } };
}

async function installAgreement(
  fixture: Awaited<ReturnType<typeof vector>>,
  agreementScope: Obj,
  signaturePrefix?: string,
) {
  const agreementSignatures = await Promise.all([0, 1].map(async (signer) => {
    if (!signaturePrefix) return sign(agreementScope, "agreement", signer, true);
    const value = Buffer.from(await ed25519Sign(
      Buffer.from(signaturePrefix + artifactHash(agreementScope, "agreement")),
      privateKeyFromSeed(seeds[signer]),
    )).toString("base64url");
    return { party: dids[signer], algorithm: "ed25519", value };
  }));
  const agreement = { ...agreementScope, signatures: agreementSignatures };
  maps.set(fixture.locators.agreement, agreement);

  const installBundle = async (raw: Obj, role: "buyer" | "seller") => {
    const scope = signedScope(raw, "bundle");
    scope.agreementRef = ref(fixture.locators.agreement, agreement, "agreement");
    const signatures = [await sign(scope, "bundle", 0, true), await sign(scope, "bundle", 1, true)];
    const bundle = { ...scope, signatures, anchoredByRole: role };
    maps.set(role === "buyer" ? fixture.locators.buyer : fixture.locators.seller, bundle);
    return bundle;
  };
  fixture.agreement = agreement;
  fixture.buyerBundle = await installBundle(fixture.buyerBundle, "buyer");
  fixture.sellerBundle = await installBundle(fixture.sellerBundle, "seller");
}

/** The bundle phaseSummary for a rewritten listing pipeline: one ok entry per phase. */
const phaseSummaryOf = (listing: Obj) => (listing.pipeline as Obj[]).map((phase, index) => ({ index, kind: phase.kind, outcome: "ok" }));

/** Re-sign the seller's payment evidence for `amount` DEM, with its settlement reference and
 * payment AnchorBinding in both bundles; installAgreement then re-signs the bundles. */
async function repay(fixture: Awaited<ReturnType<typeof vector>>, amount: string) {
  const scope = signedScope(fixture.evidence, "evidence");
  scope.paymentAmount = { amount, currency: "DEM" };
  fixture.evidence = { ...scope, signature: await sign(scope, "evidence", 1) };
  maps.set(fixture.locators.evidence, fixture.evidence);
  const binding = await paymentAnchorBinding(seeds[1], String(scope.jobId), "demos-native:DEM", 2, fixture.locators.evidence, artifactHash(fixture.evidence, "evidence"));
  for (const bundle of [fixture.buyerBundle, fixture.sellerBundle]) {
    bundle.settlementEvidence = (bundle.settlementEvidence as Obj[]).map((entry) =>
      (entry.anchor as Obj).locator === fixture.locators.evidence ? ref(fixture.locators.evidence, fixture.evidence, "evidence") : entry);
    bundle.anchorBindings = (bundle.anchorBindings as Obj[]).map((entry) => entry.nativeAddress === fixture.locators.evidence ? binding : entry);
  }
}

async function payeeBoundVector(jobId = "payee-bound-job", offset = 0) {
  const fixture = await vector(jobId, offset);
  const listingScope = signedScope(fixture.listing, "listing");
  listingScope.pipeline = (listingScope.pipeline as Obj[]).map((phase) =>
    phase.kind === "commit-agreement" ? { ...phase, kind: "commit-payee-bound-agreement" } : phase);
  const listing = { ...listingScope, signature: await sign(listingScope, "listing", 1) };
  maps.set(fixture.locators.listing, listing);
  fixture.listing = listing;

  const listingRef = { listingId: "svc", version: 1, contentHash: artifactHash(listing, "listing") };
  const agreementScope: Obj = {
    payeeBoundAgreementVersion: "1",
    jobId,
    listingRef,
    derivedFromPattern: "fixed-price",
    parties: [{ role: "buyer", primaryClaim: dids[0] }, { role: "seller", primaryClaim: dids[1] }],
    terms: {
      price: { amount: "1.25", currency: "DEM" },
      rail: { railId: "demos-native:DEM" },
      deliverable: deliverableRef,
      payoutBindings: [{ railId: "demos-native:DEM", phaseIndex: 2, payeeAddress: dids[1] }],
    },
  };

  const updateListingRef = (raw: Obj) => {
    const scope = signedScope(raw, "bundle");
    scope.listingRef = listingRef;
    scope.phaseSummary = (scope.phaseSummary as Obj[]).map((phase) => phase.kind === "commit-agreement" ? { ...phase, kind: "commit-payee-bound-agreement" } : phase);
    return { ...scope, signatures: raw.signatures, anchoredByRole: raw.anchoredByRole };
  };
  fixture.buyerBundle = updateListingRef(fixture.buyerBundle);
  fixture.sellerBundle = updateListingRef(fixture.sellerBundle);
  await installAgreement(fixture, agreementScope);
  return fixture;
}

async function graphAt(at: string, listing: Obj, listingLocator: string) {
  return buildCurrentEvidenceGraph(at, {
    resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (locatorValue) => maps.get(locatorValue) ?? null,
    resolveListing: async () => ({ locator: listingLocator, raw: listing }),
  });
}

function registeredDeal(jobId: string, buyer: string, seller: string): RegisteredDeal {
  return { jobId, rail: "demos-native:DEM", buyerBundleRef: buyer, sellerBundleRef: seller, owners: { buyer: dids[0], seller: dids[1] } };
}

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
  assert.equal(agreementRail(agreement), "demos-native:DEM");
  assert.equal(agreementRail({
    terms: { rail: { railId: "ap2:stripe-paymentintents" } },
  }), "ap2:stripe-paymentintents");
  assert.equal(agreementRail({ terms: { rail: { railId: "" } } }), null);
  assert.equal(agreementRail({ terms: { rail: "demos-native:DEM" } }), null);
  const graph = await buildCurrentEvidenceGraph(locators.buyer, { resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locators.listing, raw: listing }) });
  assert.equal(graph.ok, true, graph.reason); assert.equal(graph.ratings.length, 1);
  const ratingScope = signedScope(rating, "rating");
  maps.set(locator(4), { ...ratingScope, signature: await sign(ratingScope, "rating", 1) });
  const forgedRater = await buildCurrentEvidenceGraph(locator(5), { resolveRecipeSnapshot: fixtureRecipeSnapshot, resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? null,
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
  const mismatchedTargetRole = await buildCurrentEvidenceGraph(locator(5), { resolveRecipeSnapshot: fixtureRecipeSnapshot, resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(mismatchedTargetRole.ok, false);
  maps.set(locator(4), rating);

  const linkedPhase = signedScope(bundle, "bundle");
  linkedPhase.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" }, {
    index: 2,
    kind: "pay-dem",
    outcome: "ok",
    attestationRef: (bundle.settlementEvidence as unknown[])[0],
  }, { index: 3, kind: "deliver-storage-program", outcome: "ok" }];
  maps.set(locator(5), await resignBundle(linkedPhase));
  const linked = await buildCurrentEvidenceGraph(locator(5), { resolveRecipeSnapshot: fixtureRecipeSnapshot, resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(linked.ok, true, linked.reason);

  maps.set(locator(5), { ...bundle, signatures: [...(bundle.signatures as unknown[]), null] });
  const malformedSignature = await buildCurrentEvidenceGraph(locator(5), { resolveRecipeSnapshot: fixtureRecipeSnapshot, resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(malformedSignature.ok, false);

  maps.set(locator(5), { ...bundle, signature: null });
  const ambiguousBundleSignature = await buildCurrentEvidenceGraph(locator(5), { resolveRecipeSnapshot: fixtureRecipeSnapshot, resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(ambiguousBundleSignature.ok, false);

  const wrongAlgorithmSignatures = (bundle.signatures as Obj[]).map((signature, index) =>
    index === 0 ? { ...signature, algorithm: "ecdsa-secp256k1" } : signature);
  maps.set(locator(5), { ...bundle, signatures: wrongAlgorithmSignatures });
  const wrongAlgorithm = await buildCurrentEvidenceGraph(locator(5), { resolveRecipeSnapshot: fixtureRecipeSnapshot, resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(wrongAlgorithm.ok, false);

  const missingRequiredArray = signedScope(bundle, "bundle");
  delete missingRequiredArray.settlementEvidence;
  maps.set(locator(5), await resignBundle(missingRequiredArray));
  const missingRefs = await buildCurrentEvidenceGraph(locator(5), { resolveRecipeSnapshot: fixtureRecipeSnapshot, resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(missingRefs.ok, false);
  assert.equal(missingRefs.reason, "invalid current DACS-5 bundle shape");

  const unsupportedAmendment = signedScope(bundle, "bundle");
  unsupportedAmendment.amendments = [{}];
  maps.set(locator(5), await resignBundle(unsupportedAmendment));
  const amendment = await buildCurrentEvidenceGraph(locator(5), { resolveRecipeSnapshot: fixtureRecipeSnapshot, resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(amendment.ok, false);
  assert.equal(amendment.reason, "duplicate or invalid top-level reference", "an amendments entry must be a reference");

  const invalidRatingRefs = signedScope(bundle, "bundle");
  invalidRatingRefs.ratingRefs = "not-an-array";
  maps.set(locator(5), await resignBundle(invalidRatingRefs));
  const invalidRatings = await buildCurrentEvidenceGraph(locator(5), { resolveRecipeSnapshot: fixtureRecipeSnapshot, resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(invalidRatings.ok, false);

  const duplicateTopLevel = signedScope(bundle, "bundle");
  duplicateTopLevel.ratingRefs = [
    ...(bundle.ratingRefs as unknown[]),
    (bundle.ratingRefs as unknown[])[0],
  ];
  maps.set(locator(5), await resignBundle(duplicateTopLevel));
  const duplicateRefs = await buildCurrentEvidenceGraph(locator(5), { resolveRecipeSnapshot: fixtureRecipeSnapshot, resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(duplicateRefs.ok, true, duplicateRefs.reason);
  assert.equal(duplicateRefs.ratings.length, 1);

  const orphanedPhase = signedScope(bundle, "bundle");
  orphanedPhase.phaseSummary = [{
    index: 2,
    kind: "pay-dem",
    outcome: "ok",
    attestationRef: {
      anchor: { kind: "storage-program", locator: locator(99) },
      contentHash: "a".repeat(64),
    },
  }];
  maps.set(locator(5), await resignBundle(orphanedPhase));
  const orphaned = await buildCurrentEvidenceGraph(locator(5), { resolveRecipeSnapshot: fixtureRecipeSnapshot, resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? null,
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
  const badEvidenceRefs = await buildCurrentEvidenceGraph(locator(5), { resolveRecipeSnapshot: fixtureRecipeSnapshot, resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? null,
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
  const ambiguousContainers = await buildCurrentEvidenceGraph(locator(5), { resolveRecipeSnapshot: fixtureRecipeSnapshot, resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? null,
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
  const conflictingNested = await buildCurrentEvidenceGraph(locator(5), { resolveRecipeSnapshot: fixtureRecipeSnapshot, resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? null,
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
  const badCompositeRefs = await buildCurrentEvidenceGraph(locator(5), { resolveRecipeSnapshot: fixtureRecipeSnapshot, resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? null,
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
  const crossJob = await buildCurrentEvidenceGraph(locator(5), { resolveRecipeSnapshot: fixtureRecipeSnapshot, resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(crossJob.ok, false);
  assert.equal(crossJob.reason, "agreement belongs to another job");

  maps.set(locator(5), bundle);
  maps.set(locator(2), { ...agreement, signatures: [...(agreement.signatures as unknown[]), null] });
  const malformedAgreementSignature = await buildCurrentEvidenceGraph(locator(5), { resolveRecipeSnapshot: fixtureRecipeSnapshot, resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(malformedAgreementSignature.ok, false);
  maps.set(locator(2), agreement);
  maps.set(locator(4), { ...rating, jobId: "replayed" });
  const replay = await buildCurrentEvidenceGraph(locator(5), { resolveRecipeSnapshot: fixtureRecipeSnapshot, resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? null,
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
      name: "confirmed payout to an address unrelated to the seller",
      mutate: (scope) => { ((scope.terms as Obj).payoutBindings as Obj[])[0].payeeAddress = dids[0]; },
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

test("DACS-3 §8.5.2: an agreement conforms to its listing in currency, price, rail, deliverable, pattern and role direction", () => {
  const offered = { kind: "storage-program", accessModel: "public" };
  const pays = [{ kind: "commit-agreement" }, { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }];
  const listing = (pricing: Obj, negotiation: Obj = { kind: "negotiate-fixed-price" }, pipeline: Obj[] = pays): Obj => ({
    offering: { deliverable: offered }, pricing, pipeline: [negotiation, ...pipeline], acceptedRails: [{ railId: "demos-native:DEM" }],
  });
  const agreement = (terms: Obj = {}, extra: Obj = {}): Obj => ({
    agreementVersion: "1", derivedFromPattern: "fixed-price",
    parties: [{ role: "buyer", primaryClaim: dids[0] }, { role: "seller", primaryClaim: dids[1] }],
    terms: { price: { amount: "10", currency: "DEM" }, rail: { railId: "demos-native:DEM" }, deliverable: deliverableRef, ...terms }, ...extra,
  });
  const check = (deal: Obj, offer: Obj) => agreementListingConformance(deal, offer, dids[1]);
  const price = (amount: string, currency = "DEM") => ({ price: { amount, currency } });
  const fixed = listing({ kind: "fixed", price: { amount: "10", currency: "DEM" } });
  assert.equal(check(agreement(), fixed), null);
  // 1. Currency, before any amount.
  assert.equal(check(agreement(price("10", "USD")), fixed), "currency");
  // 2. Fixed: equal to the listed price.
  assert.equal(check(agreement(price("10.5")), fixed), "price");
  // 2. Negotiable: the inclusive band, bounds rounded half-up to the centre's digits.
  const rfq = { kind: "negotiate-rfq", parameters: { maxTurns: 6, timeoutSec: 60 } };
  const band = (amount: string, minPct: number, maxPct: number) =>
    listing({ kind: "negotiable", bandCenter: { amount, currency: "DEM" }, minPct, maxPct }, rfq);
  const quoted = (amount: string) => agreement(price(amount), { derivedFromPattern: "rfq" });
  for (const [amount, ok] of [["190", true], ["210", true], ["200", true], ["189.99", false], ["210.01", false]] as const) {
    assert.equal(check(quoted(amount), band("200", 5, 5)), ok ? null : "price", amount);
  }
  assert.equal(check(quoted("1.35"), band("1.5", 10, 0)), "price", "1.35 rounds half-up to a 1.4 lower bound");
  assert.equal(check(quoted("1.4"), band("1.5", 10, 0)), null);
  assert.equal(check(quoted("0.6"), band("1", 50, 0)), "price", "0.5 rounds half-up to 1");
  assert.equal(check(quoted("1"), band("1", 60, 0)), "price", "a lower bound that rounds to 0 rejects the listing");
  // 2. Fixed-price over negotiable pricing takes the band centre exactly.
  const fixedOverBand = listing({ kind: "negotiable", bandCenter: { amount: "200", currency: "DEM" }, minPct: 5, maxPct: 5 });
  assert.equal(check(agreement(price("200")), fixedOverBand), null);
  assert.equal(check(agreement(price("195")), fixedOverBand), "price");
  // 2. Metered: max(minTotal, unitPrice × quantity) for the declared unit and a canonical quantity.
  const metered = listing({ kind: "metered", unitPrice: { amount: "0.02", currency: "DEM" }, unit: "call", minTotal: { amount: "1", currency: "DEM" } });
  const usage = (amount: string, quantity: unknown, unit = "call") => agreement({ ...price(amount), meteredQuantity: { quantity, unit } });
  assert.equal(check(usage("2", "100"), metered), null);
  assert.equal(check(usage("1", "10"), metered), null, "the minimum total applies");
  for (const [deal, name] of [[usage("0.2", "10"), "below the minimum"], [usage("2", "100", "token"), "another unit"],
    [usage("2", "0100"), "non-canonical quantity"], [usage("2", 100), "numeric quantity"], [agreement(price("2")), "no quantity"]] as const) {
    assert.equal(check(deal, metered), "price", name);
  }
  assert.equal(check(agreement(), listing({ kind: "subscription", price: { amount: "10", currency: "DEM" } })), "unrecognized-pricing-kind");
  // 3. Rail: present exactly when the pipeline pays, and accepted by the listing.
  assert.equal(check(agreement({ rail: undefined }), fixed), "rail");
  assert.equal(check(agreement({ rail: "demos-native:DEM" }), fixed), "rail");
  assert.equal(check(agreement({ rail: { railId: "pay-x402" } }), fixed), "rail");
  assert.equal(check(agreement({ rail: { railId: "demos-native:DEM", railVersion: 2 } }), fixed), "rail");
  assert.equal(check(agreement({ rail: { railId: "demos-native:DEM", railVersion: 1 } }), { ...fixed, acceptedRails: [{ railId: "demos-native:DEM", railVersion: 1 }] }), null);
  const intakeOnly = listing({ kind: "fixed", price: { amount: "10", currency: "DEM" } }, undefined, [{ kind: "commit-agreement" }]);
  assert.equal(check(agreement({ rail: undefined }), intakeOnly), null);
  assert.equal(check(agreement(), intakeOnly), "rail");
  // 4. Deliverable.
  for (const deliverable of [undefined, { ...deliverableRef, hash: "0".repeat(64) }, { ...deliverableRef, deliverableType: "attested-payload" },
    { ...deliverableRef, schemaUrl: "https://schema.example" }]) {
    assert.equal(check(agreement({ deliverable }), fixed), "deliverable", JSON.stringify(deliverable));
  }
  // 7. Pattern.
  assert.equal(check(agreement({}, { derivedFromPattern: "rfq" }), fixed), "pattern");
  assert.equal(check(agreement({}, { derivedFromPattern: undefined }), fixed), "pattern");
  // An RFQ step declaring fixedPriceFallback also admits a fixed-price agreement at the band centre (DACS-3 §8.5.2, PS-3).
  const fallback = (fixedPriceFallback: unknown) => listing({ kind: "negotiable", bandCenter: { amount: "200", currency: "DEM" }, minPct: 5, maxPct: 5 },
    { kind: "negotiate-rfq", parameters: { maxTurns: 6, timeoutSec: 60, fixedPriceFallback } });
  assert.equal(check(agreement(price("200")), fallback(true)), null);
  assert.equal(check(agreement(price("205")), fallback(true)), "price", "the fallback takes the band centre exactly");
  assert.equal(check(agreement(price("200")), fallback(false)), "pattern");
  assert.equal(check(agreement(price("200")), fallback("true")), "pattern");
  assert.equal(check(agreement(price("205"), { derivedFromPattern: "rfq" }), fallback(true)), null);
  // 8. Role direction: the publisher sells, except in a procurement, where it buys (SE-8).
  const swapped = { parties: [{ role: "buyer", primaryClaim: dids[1] }, { role: "seller", primaryClaim: dids[0] }] };
  assert.equal(check(agreement({}, swapped), fixed), "role-direction");
  const procurement = listing({ kind: "auction", selectionRule: "lowest-price" }, { kind: "negotiate-sealed-envelope-procurement" });
  assert.equal(check(agreement({}, { derivedFromPattern: "sealed-envelope" }), procurement), "role-direction");
  assert.equal(check(agreement({}, { derivedFromPattern: "sealed-envelope", ...swapped }), procurement), null);
  // 9. Artifact type matches the commitment phase.
  const payeeBound = listing({ kind: "fixed", price: { amount: "10", currency: "DEM" } }, undefined, [{ kind: "commit-payee-bound-agreement" }, ...pays.slice(1)]);
  assert.equal(check(agreement(), payeeBound), "commitment-artifact");
});

test("a bundle within the 128 KB DACS-5 storage soft cap verifies, and one above it does not", async () => {
  const { listing, buyerBundle } = await vector("sized-job", 720);
  const sized = async (bytes: number) => {
    const scope = signedScope(buyerBundle, "bundle");
    scope.producerNote = "";
    const base = Buffer.byteLength(JSON.stringify(await resignBundle(scope)), "utf8");
    scope.producerNote = "x".repeat(bytes - base);
    const bundle = await resignBundle(scope);
    assert.equal(Buffer.byteLength(JSON.stringify(bundle), "utf8"), bytes);
    maps.set(locator(725), bundle);
    return graphAt(locator(725), listing, locator(721));
  };
  const within = await sized(128 * 1024);
  assert.equal(within.ok, true, within.reason);
  assert.equal((await sized(100_000)).ok, true);
  assert.equal((await sized(128 * 1024 + 1)).reason, "invalid current DACS-5 bundle shape");
});

test("the evidence graph rejects an agreement that does not conform to its listing", async () => {
  const fixture = await vector("nonconforming-job", 700);
  const scope = signedScope(fixture.agreement, "agreement");
  await installAgreement(fixture, { ...scope, terms: { ...(scope.terms as Obj), price: { amount: "1.3", currency: "DEM" } } });
  const graph = await graphAt(fixture.locators.buyer, fixture.listing, fixture.locators.listing);
  assert.equal(graph.reason, "agreement fails listing conformance check: price");
});

test("current evidence graph accepts a verified vet record as its phase attestation", async () => {
  const { listing, buyerBundle: bundle, primaryProof } = await vector("job-1", 0, 1, txHashOf("job-1"), 100, true);
  const compositeScope: Obj = {
    recordVersion: "1",
    jobId: "job-1",
    evaluatedParty: dids[1],
    bundleHash: (bundle.parties as Obj[])[1].bundleHash,
    requirementHash: "c".repeat(64),
    freshness: [],
    supplementary: [],
    dealSpecific: [],
    overallDecision: "pass",
    generatedAt: 30,
  };
  const composite = {
    ...compositeScope,
    signature: await sign(compositeScope, "composite", 0),
  };
  maps.set(locator(6), composite);

  const scope = signedScope(bundle, "bundle");
  const buyerScope = { ...compositeScope, evaluatedParty: dids[0], bundleHash: (bundle.parties as Obj[])[0].bundleHash, requirementHash: contentHash(listing.buyerRequirement as Obj), freshness: [primaryProof] };
  const buyerComposite = { ...buyerScope, signature: await sign(buyerScope, "composite", 1) };
  maps.set(locator(19), buyerComposite);
  scope.vetRecords = [ref(locator(6), composite, "composite"), ref(locator(19), buyerComposite, "composite")];
  scope.phaseSummary = (listing.pipeline as Obj[]).map((phase, index) => ({ index, kind: phase.kind, outcome: "ok", ...(index === 0 ? { attestationRef: (scope.vetRecords as unknown[])[0] } : {}) }));
  maps.set(locator(5), await resignBundle(scope));

  const graphWith = (deps = vetDeps(primaryProof)) => buildCurrentEvidenceGraph(locator(5), { ...deps, resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  const graph = await graphWith();
  assert.equal(graph.ok, true, graph.reason);
  // Without a trusted control adapter for the presented primary, session vet admission fails closed.
  assert.equal((await graphWith({ ...vetDeps(primaryProof), verifyPrimaryClaimControl: undefined })).reason,
    "committed vet lacks passing verification evidence for the listing's requirements");
});

test("a vet record binds the listing's requirement and must pass for a vet phase or agreement to rest on it (DACS-2 §7.7, VPC-4)", async () => {
  const { listing, buyerBundle: bundle, primaryProof } = await vector("job-1", 0, 1, txHashOf("job-1"), 100, true);
  const requirementHash = contentHash((listing as Obj).buyerRequirement as Obj);
  const record = (party: number, extra: Obj = {}): Obj => ({
    recordVersion: "1", jobId: "job-1", evaluatedParty: dids[party], bundleHash: (bundle.parties as Obj[])[party].bundleHash,
    requirementHash: party === 0 ? requirementHash : "c".repeat(64),
    freshness: party === 0 ? [primaryProof] : [], supplementary: [], dealSpecific: [], overallDecision: "pass", generatedAt: 30, ...extra,
  });
  const graphWith = async (records: Obj[], vetPhase: number | null) => {
    const refs: Obj[] = [];
    for (const [index, scope] of records.entries()) {
      const signed = { ...scope, signature: await sign(scope, "composite", 1) };
      maps.set(locator(20 + index), signed);
      refs.push(ref(locator(20 + index), signed, "composite"));
    }
    const scope = signedScope(bundle, "bundle");
    scope.vetRecords = refs;
    scope.phaseSummary = (listing.pipeline as Obj[]).map((phase, index) => ({ index, kind: phase.kind, outcome: "ok", ...(index === 0 && vetPhase !== null ? { attestationRef: refs[vetPhase] } : {}) }));
    maps.set(locator(5), await resignBundle(scope));
    return buildCurrentEvidenceGraph(locator(5), { ...vetDeps(primaryProof), resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? null,
      resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  };
  // The buyer is vetted against the listing's buyerRequirement; the publisher against requirements the listing omits.
  assert.equal((await graphWith([record(0), record(1)], 0)).ok, true);
  assert.equal((await graphWith([record(0, { requirementHash: "c".repeat(64) })], null)).reason,
    "composite record is not bound to the listing's requirement");
  for (const overallDecision of ["fail", "indeterminate", "error"]) {
    assert.equal((await graphWith([record(0, { overallDecision })], 0)).ok, false, overallDecision);
    assert.equal((await graphWith([record(0, { overallDecision })], null)).reason,
      "a committed session has a vetted party with no passing composite record", overallDecision);
  }
  // A failed attempt beside the passing record for the same party is consistent with the session.
  assert.equal((await graphWith([record(0, { overallDecision: "fail", generatedAt: 20 }), record(0), record(1)], 1)).ok, true);
  // A failed vet on a session that never reached its agreement is ordinary evidence of that failure.
  const aborted = signedScope(bundle, "bundle");
  delete aborted.agreementRef;
  aborted.outcome = "aborted-by-self";
  const failing = { ...record(0, { overallDecision: "fail" }) };
  const signedFailing = { ...failing, signature: await sign(failing, "composite", 1) };
  maps.set(locator(20), signedFailing);
  aborted.vetRecords = [ref(locator(20), signedFailing, "composite")];
  aborted.phaseSummary = [{ index: 0, kind: "vet-credentials", outcome: "fail", errorClass: "counterparty", attestationRef: (aborted.vetRecords as unknown[])[0] }];
  aborted.settlementEvidence = [];
  aborted.ratingRefs = [];
  maps.set(locator(5), await resignBundle(aborted));
  const abortedGraph = await buildCurrentEvidenceGraph(locator(5), { ...vetDeps(primaryProof), resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  assert.equal(abortedGraph.ok, true, abortedGraph.reason);
});

test("current evidence graph resolves VerifyResult authority attestations", async (t) => {
  const oldPolicies = process.env.DACS_RECIPE_POLICIES;
  t.after(() => {
    if (oldPolicies === undefined) delete process.env.DACS_RECIPE_POLICIES;
    else process.env.DACS_RECIPE_POLICIES = oldPolicies;
  });
  process.env.DACS_RECIPE_POLICIES = JSON.stringify([{ scheme: "lei", recipeVersion: 1, methods: ["consensus-backed-proxy"], availability: "live", defaultMaxAgeSec: 1, trustedResultSigners: [dids[0]] }]);
  const { listing, buyerBundle: bundle } = await vector();
  const attestation = authorityProof({ authority: "registry", status: "active" });
  maps.set(locator(7), attestation);
  const verifyResultScope: Obj = {
    resultVersion: "1",
    scheme: "lei",
    identifier: "123",
    recipeVersion: 1,
    method: "consensus-backed-proxy",
    decision: "pass",
    reason: "found",
    attestation: { ...ref(locator(7), attestation, "attestation"), contentHash: proofHash(attestation), signer: authoritySigner },
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
    bundleHash: "b".repeat(64),
    requirementHash: "c".repeat(64),
    freshness: [ref(locator(8), verifyResult, "verify-result", { recipeVersion: 1 })],
    supplementary: [],
    dealSpecific: [],
    overallDecision: "pass",
    generatedAt: 30,
  };
  const graphWith = async (composite: Obj, authenticated = true) => {
    const signed = { ...composite, signature: await sign(composite, "composite", 0) };
    maps.set(locator(6), signed);
    const scope = signedScope(bundle, "bundle");
    scope.vetRecords = [ref(locator(6), signed, "composite")];
    maps.set(locator(5), await resignBundle(scope));
    return buildCurrentEvidenceGraph(locator(5), { verifyAttestation: authenticated ? verifyTestAuthority : undefined, resolveRecipeSnapshot: async (registryVersion) => ({ registryVersion, recipes: JSON.parse(process.env.DACS_RECIPE_POLICIES!) }), resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? null,
      resolveListing: async () => ({ locator: locator(1), raw: listing }) });
  };

  assert.equal((await graphWith(compositeScope, false)).ok, false, "no authority adapter cannot grant graph standing");
  const graph = await graphWith(compositeScope);
  assert.equal(graph.ok, true, graph.reason);
  assert.equal(graph.artifacts.some((artifact) => artifact.kind === "attestation"), true);

  // DACS-2 §7.7: the record's required members, and its binding to one session party's IdentityBundle.
  for (const member of ["bundleHash", "requirementHash", "generatedAt"]) {
    const missing = { ...compositeScope };
    delete missing[member];
    assert.equal((await graphWith(missing)).reason, "composite reference failed", member);
  }
  assert.equal((await graphWith({ ...compositeScope, evaluatedParty: `did:demos:agent:${"9".repeat(64)}` })).reason,
    "composite record is not bound to a session party's bundle");
  assert.equal((await graphWith({ ...compositeScope, bundleHash: "a".repeat(64) })).reason,
    "composite record is not bound to a session party's bundle", "the seller was vetted against the buyer's bundle hash");
  // A VerifyResultRef's recipeVersion must equal the resolved result's; it is load-bearing (CORE §B.3).
  for (const recipeVersion of [2, undefined]) {
    const freshness = [ref(locator(8), verifyResult, "verify-result", recipeVersion === undefined ? {} : { recipeVersion })];
    assert.equal((await graphWith({ ...compositeScope, freshness })).reason, "nested VerifyResult reference failed", String(recipeVersion));
  }
  // DACS-2 §7.5: a VerifyResult without its method, reason or fetchedAt is not one.
  for (const member of ["method", "reason", "fetchedAt", "recipeVersion"]) {
    const missing = { ...verifyResultScope };
    delete missing[member];
    const partial = { ...missing, signature: await sign(missing, "verify-result", 0) };
    maps.set(locator(9), partial);
    const freshness = [ref(locator(9), partial, "verify-result", { recipeVersion: 1 })];
    assert.equal((await graphWith({ ...compositeScope, freshness })).reason, "nested VerifyResult reference failed", member);
  }
  await graphWith(compositeScope);

  maps.set(locator(7), { ...attestation, status: "tampered" });
  // DACS-2 §7.5.2 step 2: the proof's content hash is checked before, and whatever, the adapter answers.
  for (const verifyAttestation of [undefined, async () => true]) {
    const tampered = await buildCurrentEvidenceGraph(locator(5), { verifyAttestation, resolveRecipeSnapshot: fixtureRecipeSnapshot, resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? null,
      resolveListing: async () => ({ locator: locator(1), raw: listing }) });
    assert.equal(tampered.ok, false, verifyAttestation ? "an accepting adapter" : "no adapter");
    assert.equal(tampered.reason, "VerifyResult attestation reference failed");
  }
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
  const graph = await buildCurrentEvidenceGraph(locators.buyer, { resolveSessionChallenge: async (jobId, party) => ({ jobId, party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`, issuedAt: 0, expiresAt: 120, consumedAt: 1, consumedByBundleHash: String(party.bundleHash), consumedByPresentationHash: sha256Hex(canonicalize(party.identityBundle)) }), readSettlementNode: readNativeFixture, readAnchorRecord: paymentAnchorRecord, read: async (at) => maps.get(at) ?? rating,
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
  indexScope.phaseSummary = [{ index: 3, kind: "pay-dem", outcome: "ok" }];
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
  assert.equal(indexDivergence.sellerOk, false, "the seller copy already violates the signed pipeline index");
  assert.equal(indexDivergence.refsVerified, false, "#224 equal-length index-set mismatch must be excluded");

  const kindFixture = await vector("kind-substitution-job", 30);
  // Each substituted kind is already invalid against the signed pipeline at index 3.
  for (const [role, kind] of [["buyer", "rate"], ["seller", "commit-agreement"]] as const) {
    const kindScope = signedScope(role === "buyer" ? kindFixture.buyerBundle : kindFixture.sellerBundle, "bundle");
    kindScope.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" }, { index: 2, kind: "pay-dem", outcome: "ok" }, { index: 3, kind, outcome: "ok" }];
    maps.set(kindFixture.locators[role], {
      ...kindScope,
      signatures: [await sign(kindScope, "bundle", 0, true), await sign(kindScope, "bundle", 1, true)],
      anchoredByRole: role,
    });
  }
  const kindDeal = registeredDeal("kind-substitution-job", kindFixture.locators.buyer, kindFixture.locators.seller);
  const kindDivergence = reconcileCurrentCopies(
    kindDeal,
    dids[1],
    await graphAt(kindFixture.locators.buyer, kindFixture.listing, kindFixture.locators.listing),
    await graphAt(kindFixture.locators.seller, kindFixture.listing, kindFixture.locators.listing),
  );
  assert.equal(kindDivergence.buyerOk, false);
  assert.equal(kindDivergence.sellerOk, false);
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
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") {
      const call = JSON.parse(String(init.body)).params?.[0];
      if (["getTxByHash", "getBlockByNumber"].includes(call?.message)) return Response.json({ result: 200, response: await readNativeFixture(call.message, call.data) });
    }
    const locatorValue = String(input).split("/").pop() ?? "";
    const data = maps.get(locatorValue);
    return new Response(JSON.stringify(data
      ? { success: true, owner: `0x${dids[1].slice(-64)}`, programName: OPAQUE_PROGRAM_NAME, acl: { mode: "public" }, data }
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
    assert.equal(record.deals[0].fullSignatureStanding, true, "both parties signed the authoritative copy");
    assert.deepEqual(record.deals[0].settlementTxIds, [{ id: `demos:${txHashOf(deal.jobId)}`, observedAt: 100, phaseIndex: 2,
      evidenceHash: artifactHash(fixture.evidence, "evidence") }], "SB-2 carries the citing evidence hash");
    assert.equal(record.deals[0].buyerBundleRef, fixture.locators.buyer);
    assert.notEqual(record.deals[0].buyerBundleRef, submittedBuyerPointer);
    assert.equal(record.deals[0].sellerBundleRef, fixture.locators.seller);
    assert.notEqual(record.deals[0].sellerBundleRef, submittedSellerPointer);
    assert.equal(record.deals[0].rail, "demos-native:DEM");
    assert.equal(record.reputation.bundleCount, 1);
    // The listing's hint is scoped to its own category and counts the deal made under it (DACS-1 §6.3.6).
    // A listing IdentityBundle with no verified claim leaves the seller self-declared (IT-3).
    assert.equal(record.identityTier, "self-declared");
    const hint = record.listings[0].reputationHint;
    assert.deepEqual([hint?.categoryScope, hint?.bundleCount, hint?.completionRate, hint?.averageSellerRating], ["services.test", 1, 1, 5]);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") {
      const call = JSON.parse(String(init.body)).params?.[0];
      if (["getTxByHash", "getBlockByNumber"].includes(call?.message)) return Response.json({ result: 200, response: await readNativeFixture(call.message, call.data) });
    }
    const data = maps.get(String(input).split("/").pop() ?? "");
    return new Response(JSON.stringify(data ? { success: true, owner: `0x${dids[1].slice(-64)}`, programName: OPAQUE_PROGRAM_NAME, acl: { mode: "public" }, data } : { success: false }),
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
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") {
      const call = JSON.parse(String(init.body)).params?.[0];
      if (["getTxByHash", "getBlockByNumber"].includes(call?.message)) return Response.json({ result: 200, response: await readNativeFixture(call.message, call.data) });
    }
    const data = maps.get(String(input).split("/").pop() ?? "");
    return new Response(JSON.stringify(data ? { success: true, owner: `0x${dids[1].slice(-64)}`, programName: "dacs:test", acl: { mode: "public" }, data } : { success: false }),
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
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") {
      const call = JSON.parse(String(init.body)).params?.[0];
      if (["getTxByHash", "getBlockByNumber"].includes(call?.message)) return Response.json({ result: 200, response: await readNativeFixture(call.message, call.data) });
    }
    const locatorValue = String(input).split("/").pop() ?? "";
    const data = maps.get(locatorValue);
    return new Response(JSON.stringify(data
      ? { success: true, owner: `0x${dids[1].slice(-64)}`, programName: OPAQUE_PROGRAM_NAME, acl: { mode: "public" }, data }
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
  sellerScope.phaseSummary = [{ index: 2, kind: "pay-dem", outcome: "banana" }];
  maps.set(fixture.locators.seller, {
    ...sellerScope,
    signatures: [await sign(sellerScope, "bundle", 0, true), await sign(sellerScope, "bundle", 1, true)],
    anchoredByRole: "seller",
  });
  const reads = new Map<string, number>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") {
      const call = JSON.parse(String(init.body)).params?.[0];
      if (["getTxByHash", "getBlockByNumber"].includes(call?.message)) return Response.json({ result: 200, response: await readNativeFixture(call.message, call.data) });
    }
    const locatorValue = String(input).split("/").pop() ?? "";
    reads.set(locatorValue, (reads.get(locatorValue) ?? 0) + 1);
    const data = maps.get(locatorValue);
    return new Response(JSON.stringify(data
      ? { success: true, owner: `0x${dids[1].slice(-64)}`, programName: OPAQUE_PROGRAM_NAME, acl: { mode: "public" }, data }
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
      { index: 2, kind: "pay-dem", outcome: "ok" },
      { index: 2, kind: "deliver", outcome: "ok" },
    ];
  });
  await rejects("invalid-phase-outcome", 90, (scope) => {
    scope.phaseSummary = [{ index: 2, kind: "pay-dem", outcome: "banana" }];
  });
  await rejects("invalid-phase-error-class", 100, (scope) => {
    scope.phaseSummary = [{ index: 2, kind: "pay-dem", outcome: "fail", errorClass: "banana" }];
  });
});

test("DACS-5 derives exact volume, ratings, SR-2 receipt window and transaction uniqueness", () => {
  const base: DealRecord = { jobId: "a", rail: "demos-native:DEM", buyerBundleRef: locator(5), sellerBundleRef: locator(6), owners: { buyer: dids[0], seller: dids[1] },
    signatureVerified: true, refsVerified: true, reputationEligible: true, sellerOutcome: "completed", finalisedAt: 1, anchorTimestamp: 100,
    verifiedAt: 1, bundleContentHash: "a".repeat(64), agreementPrice: { amount: "1.25", currency: "DEM" },
    settlementTxIds: [{ id: "tx", observedAt: 10, phaseIndex: 2 }], ratings: [{ rater: dids[0], target: dids[1], targetRole: "seller", value: 5, ratedAt: 10, contentHash: "b".repeat(64) }] };
  const duplicate = { ...base, jobId: "b", bundleContentHash: "c".repeat(64), agreementPrice: { amount: "9", currency: "DEM" }, settlementTxIds: [{ id: "tx", observedAt: 20, phaseIndex: 2 }] };
  const out = deriveSellerReputation([base, duplicate], 0, 200);
  assert.deepEqual(out.observedTransactionalVolume, [{ currency: "DEM", amount: "1.25" }]);
  assert.equal(out.averageSellerRating, 5); assert.equal(out.bundleCount, 1); assert.equal(out.windowingBasis, "sr2-anchor-timestamp");
});

test("SB-2: a settlement id cited at the same time by two jobs counts for the lower evidence hash", () => {
  const deal = (jobId: string, evidenceHash: string, amount: string): DealRecord => ({
    jobId, rail: "demos-native:DEM", buyerBundleRef: locator(jobId === "a" ? 160 : 161), owners: { buyer: dids[0], seller: dids[1] },
    signatureVerified: true, refsVerified: true, reputationEligible: true, sellerOutcome: "completed", finalisedAt: 1, anchorTimestamp: 100,
    verifiedAt: 1, bundleContentHash: jobId.repeat(64), agreementPrice: { amount, currency: "DEM" },
    settlementTxIds: [{ id: "demos:tx", observedAt: 10, phaseIndex: 2, evidenceHash }],
  });
  const volume = (deals: DealRecord[]) => deriveSellerReputation(deals, 0, 200).observedTransactionalVolume;
  // Job "z" sorts after "a", but its evidence hash is lower, so it keeps the settlement.
  assert.deepEqual(volume([deal("a", "f".repeat(64), "1"), deal("z", "0".repeat(64), "2")]), [{ currency: "DEM", amount: "2" }]);
  assert.deepEqual(volume([deal("z", "0".repeat(64), "2"), deal("a", "f".repeat(64), "1")]), [{ currency: "DEM", amount: "2" }]);
  // Equal evidence hashes fall back to the jobId.
  assert.deepEqual(volume([deal("z", "0".repeat(64), "2"), deal("a", "0".repeat(64), "1")]), [{ currency: "DEM", amount: "1" }]);
});

test("DACS-5 uses one window basis and omits malformed currency aggregates", () => {
  const record = (jobId: string, values: Partial<DealRecord>): DealRecord => ({
    jobId, rail: "demos-native:DEM", buyerBundleRef: locator(150 + Number(jobId)),
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
    { cancellationPolicy: "pre-commit" }, [{ kind: "negotiate-fixed-price", outcome: "ok" }], undefined), true);
  assert.equal(isNeutralCancellation("aborted-by-self", { claimedPolicy: "pre-commit" },
    { cancellationPolicy: "pre-commit" }, [{ kind: "commit-agreement", outcome: "ok" }], undefined), false);
  assert.equal(isNeutralCancellation("aborted-by-self", { claimedPolicy: "pre-commit" },
    { cancellationPolicy: "pre-commit" }, [{ kind: "commit-payee-bound-agreement", outcome: "ok" }], undefined), false);
});

test("identity tier requires a fresh passing version-pinned VerifyResult and its evidence", async () => {
  maps.clear(); const attested = authorityProof({ authority: "ok" }); maps.set(locator(8), attested);
  // A did:demos:agent proof signer models a verifiable-credential issuer; consensus-backed-proxy would need a
  // substrate-validator-set signer and roster (DACS-2 §7.5).
  const resultScope: Obj = { resultVersion: "1", scheme: "lei", identifier: "123", recipeVersion: 2, method: "verifiable-credential", decision: "pass", reason: "found",
    attestation: { anchor: { kind: "storage-program", locator: locator(8) }, contentHash: proofHash(attested), signer: authoritySigner }, fetchedAt: 10, verifiedAt: 20, validUntil: 200 };
  const result: Obj = { ...resultScope, signature: await sign(resultScope, "verify-result", 0) }; maps.set(locator(9), result);
  const identity = { claims: [{ ref: "lei:123", verifiedBy: ref(locator(9), result, "verify-result", { recipeVersion: 2 }) }] };
  const policy: RecipePolicy = { scheme: "lei", recipeVersion: 2, methods: ["verifiable-credential"], defaultMaxAgeSec: 60, availability: "live", trustedResultSigners: [dids[0]] };
  const tier = await deriveIdentityTier(identity, async () => policy, 100, async (at) => maps.get(at) ?? null, undefined, verifyTestAuthority);
  assert.equal(tier, "institutional");
  const mixedScheme = structuredClone(result);
  (mixedScheme.signature as Obj).signer = `DID:demos:agent:${dids[0].slice(-64)}`;
  maps.set(locator(9), mixedScheme);
  assert.equal(
    await deriveIdentityTier(identity, async () => policy, 100, async (at) => maps.get(at) ?? null, undefined, verifyTestAuthority),
    "institutional",
    "trusted signer comparison uses its resolved canonical identity",
  );
  assert.equal(await deriveIdentityTier(identity, async () => policy, 201, async (at) => maps.get(at) ?? null, undefined, verifyTestAuthority), "self-declared");
});

/** A seller with a plain listing and a listing whose signed IdentityBundle carries a verified lei claim,
 * served through a stubbed storage node. Call `restore()` when done. */
async function verifiedLeiSeller() {
  const fixture = await vector();
  const issued = Date.now() - 1_000;
  const proof = authorityProof({ authority: "gleif", record: "123" }); maps.set(locator(80), proof);
  const resultScope: Obj = { resultVersion: "1", scheme: "lei", identifier: "123", recipeVersion: 2, method: "verifiable-credential", decision: "pass", reason: "found",
    attestation: { anchor: { kind: "storage-program", locator: locator(80) }, contentHash: proofHash(proof), signer: authoritySigner },
    fetchedAt: issued - 10, verifiedAt: issued, validUntil: issued + 3_600_000 };
  const result: Obj = { ...resultScope, signature: await sign(resultScope, "verify-result", 0) }; maps.set(locator(81), result);
  const policy: RecipePolicy = { scheme: "lei", recipeVersion: 2, methods: ["verifiable-credential"], defaultMaxAgeSec: 60, availability: "live", trustedResultSigners: [dids[0]] };
  const resolveRecipe = async (scheme: string, version: number) => scheme === "lei" && version === 2 ? policy : null;
  // A second listing whose signed seller IdentityBundle also carries the verified lei claim.
  const scope = signedScope(fixture.listing, "listing");
  scope.listingId = "svc-lei";
  const identity: Obj = { bundleVersion: "1", presentedBy: dids[1], presentedAt: 1,
    claims: [{ ref: dids[1] }, { ref: "lei:123", verifiedBy: ref(locator(81), result, "verify-result", { recipeVersion: 2 }) }] };
  const presentation = Buffer.from(await ed25519Sign(Buffer.from(`dacs-bundle-presentation:v1:${contentHash(identity)}`), privateKeyFromSeed(seeds[1]))).toString("hex");
  scope.seller = { displayName: "seller", identity: { ...identity, presentation: { kind: "per-claim", signatures: [{ ref: dids[1], signature: presentation }] } } };
  maps.set(locator(82), { ...scope, signature: await sign(scope, "listing", 1) });
  const [plain, lei] = [fixture.locators.listing, locator(82)];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (!path.startsWith("/storage-program/")) return Response.json({ result: 200, response: [] });
    const data = maps.get(path.split("/").pop() ?? "");
    return data ? Response.json({ success: true, owner: `0x${dids[1].slice(-64)}`, programName: OPAQUE_PROGRAM_NAME, acl: { mode: "public" }, data })
      : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
  };
  const store = await import("../src/catalog/store.js");
  const priorRegs = store.loadRegistrations(); const priorDomains = store.loadDomains(); const priorState = store.loadScanState();
  const priorCatalog = store.loadCatalog();
  // A fresh scan over just this seller.
  store.saveDomains([]);
  store.saveScanState({ ...priorState, lastSeenTxId: 0, lastChainTip: 0, listings: {}, deals: {}, bundleBindings: {}, bundleBindingOverflow: [] });
  store.saveRegistrations([{ primaryClaim: dids[1], displayName: "seller", listingAnchors: [lei, plain], deals: [] }]);
  const priorVerifier = process.env[AUTHORITY_VERIFIER_ENV];
  /** Sets this process's DACS_AUTHORITY_VERIFIER; undefined unsets it. */
  const configureVerifier = (value: string | undefined) => {
    if (value === undefined) delete process.env[AUTHORITY_VERIFIER_ENV]; else process.env[AUTHORITY_VERIFIER_ENV] = value;
  };
  return {
    plain, lei, policy, resolveRecipe, configureVerifier,
    savedTier: () => store.loadCatalog().sellers.find((seller) => seller.primaryClaim === dids[1])?.identityTier,
    restore() {
      globalThis.fetch = originalFetch; configureVerifier(priorVerifier);
      store.saveRegistrations(priorRegs); store.saveDomains(priorDomains); store.saveScanState(priorState);
      store.saveCatalog(priorCatalog);
    },
  };
}
const acceptingVerifier = new URL("./fixtures/authority-verifier/accepts.ts", import.meta.url).href;
const rejectingVerifier = new URL("./fixtures/authority-verifier/rejects.ts", import.meta.url).href;
const missingVerifier = new URL("./fixtures/authority-verifier/missing.ts", import.meta.url).href;

test("indexing and reindexing raise a seller's tier only through the deployment's authority adapter", async () => {
  const { plain, lei, resolveRecipe, savedTier, configureVerifier, restore } = await verifiedLeiSeller();
  const { reindexAll } = await import("../src/catalog/reindexCore.js");
  const store = await import("../src/catalog/store.js");
  const reindex = () => reindexAll({ log: () => {}, resolveIdentities: async () => [], resolveRecipe });
  try {
    const tierOf = async (listingAnchors: string[], verifyAttestation?: typeof verifyTestAuthority) => (await indexRegistration(
      { primaryClaim: dids[1], displayName: "seller", listingAnchors, deals: [] }, undefined, async () => [], resolveRecipe, undefined, () => [], verifyAttestation)).identityTier;
    // The seller tier is the highest across every listing's bundle, whichever listing carries the claim.
    assert.equal(await tierOf([lei, plain], verifyTestAuthority), "institutional");
    assert.equal(await tierOf([plain, lei], verifyTestAuthority), "institutional");
    assert.equal(await tierOf([plain], verifyTestAuthority), "self-declared");
    assert.equal(await tierOf([lei, plain]), "self-declared", "no adapter: fails closed");
    assert.equal(await tierOf([lei, plain], async () => false), "self-declared");
    configureVerifier(acceptingVerifier);
    await reindex();
    assert.equal(savedTier(), "institutional", "the batch pass uses the configured verifier");
    assert.equal(store.loadCatalog().identityTierVerifier, acceptingVerifier, "and records it with the catalog");
    // A pass that would drop or cannot load the catalog's verifier stops before it reads or writes anything.
    const before = { catalog: store.loadCatalog(), state: store.loadScanState() };
    for (const [value, reason] of [[undefined, /derived with file:.*accepts\.ts, and DACS_AUTHORITY_VERIFIER is unset/],
      [missingVerifier, /DACS_AUTHORITY_VERIFIER file:.*missing\.ts could not be loaded/]] as const) {
      configureVerifier(value);
      await assert.rejects(reindex(), (error: unknown) => error instanceof AuthorityVerifierUnavailable && reason.test(error.message));
      assert.deepEqual({ catalog: store.loadCatalog(), state: store.loadScanState() }, before, String(value));
    }
    // A full reindex may switch verifier; the new one governs every tier and is recorded.
    configureVerifier(rejectingVerifier);
    await reindex();
    assert.equal(savedTier(), "self-declared", "the configured verifier governs the tier");
    assert.equal(store.loadCatalog().identityTierVerifier, rejectingVerifier);
    configureVerifier("none");
    await reindex();
    assert.equal(savedTier(), "self-declared", "none drops the verifier deliberately");
    assert.equal(store.loadCatalog().identityTierVerifier, undefined);
    configureVerifier(undefined);
    await reindex();
    assert.equal(savedTier(), "self-declared", "the shipped default: no verifier configured");
  } finally { restore(); }
});

test("the reindex and index-now routes derive a seller's tier with the one configured verifier", async () => {
  // Shipped entry points take no options: recipe policy and the verifier both come from the environment.
  const { policy, savedTier, configureVerifier, restore } = await verifiedLeiSeller();
  const { POST: reindex } = await import("../app/api/dacs/reindex/route.js");
  const { POST: indexNow } = await import("../app/api/dacs/index-now/route.js");
  const post = async (route: typeof reindex, path: string, status: number) => {
    const body = path === "index-now" ? { body: JSON.stringify({ claim: dids[1] }) } : {};
    const response = await route(new NextRequest(`http://directory.test/api/dacs/${path}`, { method: "POST", ...body }));
    assert.equal(response.status, status, `${path}: ${await response.clone().text()}`);
    return String((await response.json() as { error?: unknown }).error);
  };
  const priorPolicies = process.env.DACS_RECIPE_POLICIES; const priorLog = console.log;
  process.env.DACS_RECIPE_POLICIES = JSON.stringify([policy]); console.log = () => {};
  try {
    configureVerifier(acceptingVerifier);
    await post(reindex, "reindex", 200);
    assert.equal(savedTier(), "institutional", "batch reindex uses the configured verifier");
    await post(indexNow, "index-now", 200);
    assert.equal(savedTier(), "institutional", "immediate indexing keeps the batch tier");
    // A route process started without the configuration, or with one that cannot load, saves nothing.
    configureVerifier(undefined);
    assert.match(await post(indexNow, "index-now", 409), /derived with file:.*accepts\.ts, and this process has none/);
    assert.match(await post(reindex, "reindex", 503), /DACS_AUTHORITY_VERIFIER is unset/);
    assert.equal(savedTier(), "institutional", "an immediate index cannot undo the batch tier");
    configureVerifier(missingVerifier);
    assert.match(await post(indexNow, "index-now", 503), /missing\.ts could not be loaded/);
    assert.match(await post(reindex, "reindex", 503), /missing\.ts could not be loaded/);
    assert.equal(savedTier(), "institutional");
    // Dropping the verifier is a deliberate full reindex; the immediate path then matches it.
    configureVerifier("none");
    await post(reindex, "reindex", 200);
    assert.equal(savedTier(), "self-declared");
    configureVerifier(undefined);
    await post(indexNow, "index-now", 200);
    assert.equal(savedTier(), "self-declared", "the shipped default: no verifier configured");
    configureVerifier(acceptingVerifier);
    assert.match(await post(indexNow, "index-now", 409), /derived with no authority verifier, and this process has file:.*accepts\.ts/);
    assert.equal(savedTier(), "self-declared", "a verifier is adopted by a full reindex, never one seller at a time");
  } finally {
    console.log = priorLog;
    if (priorPolicies === undefined) delete process.env.DACS_RECIPE_POLICIES; else process.env.DACS_RECIPE_POLICIES = priorPolicies;
    restore();
  }
});

test("a mixed pair indexes the fault copy's advisory fields and hash even when it is the buyer copy", async () => {
  const fixture = await vector("mixed-authority");
  const scope = signedScope(fixture.buyerBundle, "bundle");
  delete scope.bundleVersion;
  Object.assign(scope, { faultBundleVersion: "1", faultedParty: "none", finalisedAt: 80, ratingRefs: [] });
  const buyer = { ...scope, signatures: [await sign(scope, "bundle", 0, true), await sign(scope, "bundle", 1, true)], anchoredByRole: "buyer" };
  maps.set(fixture.locators.buyer, buyer);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") {
      const call = JSON.parse(String(init.body)).params?.[0];
      if (["getTxByHash", "getBlockByNumber"].includes(call?.message)) return Response.json({ result: 200, response: await readNativeFixture(call.message, call.data) });
    }
    const data = maps.get(String(input).split("/").pop() ?? "");
    return data ? Response.json({ success: true, owner: `0x${dids[1].slice(-64)}`, programName: OPAQUE_PROGRAM_NAME, acl: { mode: "public" }, data })
      : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
  };
  try {
    const record = await indexRegistration({ primaryClaim: dids[1], displayName: "seller", listingAnchors: [fixture.locators.listing],
      deals: [registeredDeal("mixed-authority", fixture.locators.buyer, fixture.locators.seller)],
      bundleBindings: [await bindingFor("mixed-authority", "buyer", fixture.locators.buyer, buyer, 0),
        await bindingFor("mixed-authority", "seller", fixture.locators.seller, fixture.sellerBundle, 1)],
    }, undefined, async () => []);
    assert.equal(record.deals[0].refsVerified, true);
    assert.equal(record.deals[0].finalisedAt, 80);
    assert.equal(record.deals[0].anchoredByRole, "buyer");
    assert.equal(record.deals[0].bundleContentHash, artifactHash(buyer, "bundle"));
    assert.deepEqual(record.deals[0].ratings, []);
    assert.equal(record.reputation.averageSellerRating, null);
  } finally { globalThis.fetch = originalFetch; }
});

test("reindex and refresh never admit unsupported EVM settlements across sellers", async () => {
  const store = await import("../src/catalog/store.js");
  const { reindexAll } = await import("../src/catalog/reindexCore.js");
  // Two signed seller histories cite the same synthetic EVM settlement. Neither
  // can establish settlement without an authoritative rail adapter.
  const asEvm = async (fixture: Awaited<ReturnType<typeof vector>>, seller: number) => {
    const listingScope = signedScope(fixture.listing, "listing");
    listingScope.pipeline = (listingScope.pipeline as Obj[]).map((p) => p.kind === "pay-dem" ? { kind: "pay-evm-erc20", parameters: { rail: "evm-test" } } : p);
    listingScope.acceptedRails = [{ railId: "evm-test" }];
    fixture.listing = { ...listingScope, signature: await sign(listingScope, "listing", seller) };
    maps.set(fixture.locators.listing, fixture.listing);
    const agreement = signedScope(fixture.agreement, "agreement");
    agreement.listingRef = { listingId: "svc", version: 1, contentHash: artifactHash(fixture.listing, "listing") };
    (agreement.terms as Obj).rail = { railId: "evm-test" };
    const evidence = signedScope(fixture.evidence, "evidence");
    evidence.phase = "pay-evm-erc20";
    evidence.paymentTxRefs = [{ kind: "evm", txHash: "cd".repeat(32), chainId: 8453, logIndex: 0 }];
    evidence.settlementFinality = { model: "block-depth", finalityBlocks: 1, finalityObservedAt: 100 };
    fixture.evidence = { ...evidence, signature: await sign(evidence, "evidence", seller) };
    maps.set(fixture.locators.evidence, fixture.evidence);
    for (const [field, role, signer] of [["buyerBundle", "buyer", 1 - seller], ["sellerBundle", "seller", seller]] as const) {
      const scope = signedScope(fixture[field], "bundle");
      scope.listingRef = agreement.listingRef;
      scope.phaseSummary = (scope.phaseSummary as Obj[]).map((p) => p.kind === "pay-dem" ? { ...p, kind: "pay-evm-erc20" } : p);
      scope.settlementEvidence = [ref(fixture.locators.evidence, fixture.evidence, "evidence")];
      scope.anchorBindings = [await paymentAnchorBinding(seeds[seller], String(scope.jobId), "evm-test", 2,
        fixture.locators.evidence, artifactHash(fixture.evidence, "evidence"))];
      fixture[field] = { ...scope, anchoredByRole: role };
    }
    await installAgreement(fixture, agreement);
    return fixture;
  };
  const shared = "cd".repeat(32);
  const later = await asEvm(await vector("seller-a-later", 300, 1, shared, 20), 1);
  const laterStore = new Map(maps);
  const earlier = await asEvm(await vector("seller-b-earlier", 400, 0, shared, 10), 0);
  for (const [key, value] of laterStore) maps.set(key, value);
  const registration = async (fixture: Awaited<ReturnType<typeof vector>>, jobId: string, seller: number) => ({
    primaryClaim: dids[seller], displayName: `seller-${seller}`, listingAnchors: [fixture.locators.listing],
    deals: [{ jobId, rail: "demos-native:DEM", buyerBundleRef: fixture.locators.buyer, sellerBundleRef: fixture.locators.seller,
      owners: { buyer: dids[1 - seller], seller: dids[seller] } }],
    bundleBindings: [await bindingFor(jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 1 - seller),
      await bindingFor(jobId, "seller", fixture.locators.seller, fixture.sellerBundle, seller)],
  });
  const registrations = [await registration(later, "seller-a-later", 1), await registration(earlier, "seller-b-earlier", 0)];
  const originalFetch = globalThis.fetch;
  const priorRegs = store.loadRegistrations(); const priorDomains = store.loadDomains(); const priorState = store.loadScanState();
  const priorCatalog = store.loadCatalog();
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") {
      const call = JSON.parse(String(init.body)).params?.[0];
      if (["getTxByHash", "getBlockByNumber"].includes(call?.message)) return Response.json({ result: 200, response: await readNativeFixture(call.message, call.data) });
    }
    const path = new URL(String(input)).pathname;
    if (!path.startsWith("/storage-program/")) return Response.json({ result: 200, response: [] });
    const data = maps.get(path.split("/").pop() ?? "");
    const seller = data === later.listing ? 1 : data === earlier.listing ? 0 : 1;
    return data ? Response.json({ success: true, owner: `0x${dids[seller].slice(-64)}`, programName: OPAQUE_PROGRAM_NAME, data })
      : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
  };
  try {
    store.saveDomains([]);
    store.saveScanState({ ...priorState, lastSeenTxId: 0, lastChainTip: 0, listings: {}, deals: {}, bundleBindings: {}, bundleBindingOverflow: [] });
    for (const order of [registrations, [...registrations].reverse()]) {
      store.saveRegistrations(order);
      await reindexAll({ log: () => {}, resolveIdentities: async () => [] });
      const sellers = store.loadCatalog().sellers;
      assert.equal(sellers.length, 2);
      const winner = sellers.find((seller) => seller.primaryClaim === dids[0])!;
      const loser = sellers.find((seller) => seller.primaryClaim === dids[1])!;
      assert.equal(winner.deals[0].refsVerified, false); assert.equal(loser.deals[0].refsVerified, false);
      assert.equal(winner.reputation.completed, 0); assert.equal(loser.reputation.completed, 0);
      assert.equal(winner.deals[0].reputationEligible, false); assert.equal(loser.deals[0].reputationEligible, false);
      assert.equal(winner.deals[0].settlementRejected, undefined); assert.equal(loser.deals[0].settlementRejected, undefined);
      assert.equal(winner.listings[0].reputationHint?.bundleCount, 0); assert.equal(loser.listings[0].reputationHint?.bundleCount, 0);
      assert.deepEqual(loser.reputation.observedTransactionalVolume, []);

      // Run the immediate-refresh publication operations in both arrival orders. Refreshing
      // either participant must not restore the later claim or duplicate volume/ratings.
      for (const reg of order) {
        const catalog = store.loadCatalog();
        const i = catalog.sellers.findIndex((seller) => seller.primaryClaim === reg.primaryClaim);
        catalog.sellers[i] = await indexRegistration(reg, catalog.sellers[i], async () => []);
        catalog.generatedAt = Date.now();
        store.saveCatalog(catalog);
        const published = store.loadCatalog().sellers;
        assert.deepEqual(published.map((seller) => seller.reputation.completed).sort(), [0, 0]);
        const rejected = published.find((seller) => seller.primaryClaim === dids[1])!;
        assert.deepEqual(rejected.reputation.observedTransactionalVolume, []);
        assert.equal(rejected.reputation.averageSellerRating, null);
        assert.equal(rejected.listings[0].reputationHint?.bundleCount, 0);
      }

      // Removing the other seller cannot admit an unverified settlement.
      const catalog = store.loadCatalog();
      catalog.sellers = catalog.sellers.filter((seller) => seller.primaryClaim === dids[1]);
      store.saveCatalog(catalog);
      const reconsidered = store.loadCatalog().sellers[0];
      assert.equal(reconsidered.deals[0].reputationEligible, false);
      assert.equal(reconsidered.deals[0].settlementRejected, undefined);
      assert.equal(reconsidered.reputation.completed, 0);
      assert.deepEqual(reconsidered.reputation.observedTransactionalVolume, []);
      assert.equal(reconsidered.listings[0].reputationHint?.bundleCount, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
    store.saveRegistrations(priorRegs); store.saveDomains(priorDomains); store.saveScanState(priorState);
    store.saveCatalog(priorCatalog);
  }
});

test("passive reindex carries signed holder bindings and unions sticky cache and scanner overflows", async () => {
  const store = await import("../src/catalog/store.js");
  const { reindexAll } = await import("../src/catalog/reindexCore.js");
  const { bundleBindingOverflowKey } = await import("../src/catalog/bundleBinding.js");
  const fixture = await vector("passive-binding-job", 1600);
  const originalMaps = new Map(maps);
  const priorRegs = store.loadRegistrations(); const priorDomains = store.loadDomains(); const priorState = store.loadScanState();
  const priorCatalog = store.loadCatalog();
  const originalFetch = globalThis.fetch;
  const previousDepth = process.env.DACS_SCAN_FINALITY_DEPTH;
  process.env.DACS_SCAN_FINALITY_DEPTH = "0";
  try {
    store.saveRegistrations([]); store.saveDomains([]);
    for (const fromRegistration of [false, true]) for (const flood of [false, true]) for (const sticky of [false, true]) {
      maps.clear(); for (const [key, value] of originalMaps) maps.set(key, value);
      const bindings = [];
      for (const [role, signer, bundle, native] of [["buyer", 0, fixture.buyerBundle, fixture.locators.buyer], ["seller", 1, fixture.sellerBundle, fixture.locators.seller]] as const) {
        for (let index = 0; index < (flood ? 33 : 1); index++) {
          const address = index === 0 ? native : locator(1700 + signer * 100 + index);
          maps.set(address, bundle);
          const bound = await bindingFor("passive-binding-job", role, address, bundle, signer);
          maps.set(locator(2000 + signer * 100 + index), bound as unknown as Obj); bindings.push(bound);
        }
      }
      store.saveRegistrations(fromRegistration ? [{ primaryClaim: dids[1], displayName: "registered", listingAnchors: [fixture.locators.listing],
        deals: [registeredDeal("passive-binding-job", fixture.locators.buyer, fixture.locators.seller)], bundleBindings: bindings }] : []);
      const buyerOverflow = bundleBindingOverflowKey("passive-binding-job", "buyer", dids[0]);
      const sellerOverflow = bundleBindingOverflowKey("passive-binding-job", "seller", dids[1]);
      const unrelated = bundleBindingOverflowKey("other-job", "buyer", dids[0]);
      store.saveScanState({ schemaVersion: 10, lastSeenTxId: 0, lastChainTip: 0, listings: {}, deals: {}, programs: {},
        bundleBindings: { "passive-binding-job": [bindings[0]] }, bundleBindingOverflow: sticky ? [unrelated, buyerOverflow] : [],
        revocations: {}, verifiedRevocations: {} });
      globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") {
      const call = JSON.parse(String(init.body)).params?.[0];
      if (["getTxByHash", "getBlockByNumber"].includes(call?.message)) return Response.json({ result: 200, response: await readNativeFixture(call.message, call.data) });
    }
        const path = new URL(String(input)).pathname;
        if (!path.startsWith("/storage-program/")) return Response.json({ result: 200, response: fromRegistration ? [] : [{ id: 1, content: [...maps.keys()] }] });
        const native = path.split("/").pop() ?? "";
        const data = maps.get(native);
        const owner = native === fixture.locators.listing ? dids[1] : data?.anchoredByRole === "buyer" ? dids[0] : dids[1];
        return data ? Response.json({ success: true, owner: `0x${owner.slice(-64)}`, programName: OPAQUE_PROGRAM_NAME, acl: { mode: "public" }, data })
          : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
      };
      await reindexAll({ log: () => {}, resolveIdentities: async () => [] });
      const saved = store.loadScanState();
      assert.deepEqual(saved.bundleBindings!["passive-binding-job"].map((binding) => JSON.stringify(binding)).sort(), bindings.map((binding) => JSON.stringify(binding)).sort());
      const expectedOverflow = [...new Set([...(sticky ? [unrelated, buyerOverflow] : []), ...(flood ? [buyerOverflow, sellerOverflow] : [])])].sort();
      assert.deepEqual(saved.bundleBindingOverflow, expectedOverflow);
      const seller = store.loadCatalog().sellers.find((seller) => seller.primaryClaim === dids[1])!;
      assert.ok(seller, "the seller is discovered without registration");
      const counted = !sticky && !flood;
      assert.equal(seller.deals[0].refsVerified, counted);
      assert.equal(seller.reputation.completed, counted ? 1 : 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousDepth === undefined) delete process.env.DACS_SCAN_FINALITY_DEPTH; else process.env.DACS_SCAN_FINALITY_DEPTH = previousDepth;
    store.saveRegistrations(priorRegs); store.saveDomains(priorDomains); store.saveScanState(priorState);
    store.saveCatalog(priorCatalog);
  }
});

test("history replay discards pre-v9 attribution and a later duplicate invalidates cached legacy copy pointers", async () => {
  const store = await import("../src/catalog/store.js");
  const { reindexAll } = await import("../src/catalog/reindexCore.js");
  const { discoveredDealKey } = await import("../src/catalog/scanState.js");
  const originalFetch = globalThis.fetch;
  const priorState = store.loadScanState(); const priorRegs = store.loadRegistrations(); const priorDomains = store.loadDomains();
  const priorCatalog = store.loadCatalog();
  const previousDepth = process.env.DACS_SCAN_FINALITY_DEPTH; process.env.DACS_SCAN_FINALITY_DEPTH = "0";
  const deal = { jobId: "cached-legacy", rail: "demos-native:DEM", buyerBundleRef: locator(3001), sellerBundleRef: locator(3002),
    owners: { buyer: dids[0], seller: dids[1] }, sellerFromAgreement: dids[1] };
  const key = discoveredDealKey(dids[0], deal.jobId);
  try {
    store.saveRegistrations([]); store.saveDomains([]);
    store.saveScanState({ schemaVersion: 8, lastSeenTxId: 0, listings: {}, deals: { [key]: deal }, programs: {} });
    globalThis.fetch = async () => Response.json({ result: 200, response: [] });
    await reindexAll({ log: () => {}, resolveIdentities: async () => [] });
    assert.deepEqual(Object.keys(store.loadScanState().deals), []);
    for (const name of [`dacs3:agreement:${deal.jobId}`, `dacs5:bundle:${deal.jobId}`]) {
      const programKey = store.programBindingKey(dids[0], name);
      const duplicate = locator(3003);
      store.saveScanState({ schemaVersion: 10, lastSeenTxId: 0, listings: {}, deals: { [key]: structuredClone(deal) }, programs: { [programKey]: locator(3000) } });
      globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") {
      const call = JSON.parse(String(init.body)).params?.[0];
      if (["getTxByHash", "getBlockByNumber"].includes(call?.message)) return Response.json({ result: 200, response: await readNativeFixture(call.message, call.data) });
    }
        const path = new URL(String(input)).pathname;
        if (!path.startsWith("/storage-program/")) return Response.json({ result: 200, response: [{ id: 1, content: duplicate }] });
        return path.endsWith(duplicate)
          ? Response.json({ success: true, owner: `0x${dids[0].slice(-64).toUpperCase()}`, programName: name, data: {} })
          : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
      };
      await reindexAll({ log: () => {}, resolveIdentities: async () => [] });
      const state = store.loadScanState();
      assert.equal(state.programs[programKey], null, name);
      assert.equal(state.deals[key].owners.seller, "", name);
      assert.equal(state.deals[key].sellerBundleRef, undefined, name);
      assert.equal((state.deals[key] as unknown as Obj).sellerFromAgreement, undefined, name);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousDepth === undefined) delete process.env.DACS_SCAN_FINALITY_DEPTH; else process.env.DACS_SCAN_FINALITY_DEPTH = previousDepth;
    store.saveScanState(priorState); store.saveRegistrations(priorRegs); store.saveDomains(priorDomains);
    store.saveCatalog(priorCatalog);
  }
});

test("indexer persists authoritative orchestrator neutrality from a verified FAB pair", async () => {
  const fixture = await vector("orchestrator-neutral", 900);
  const copies: Obj[] = [];
  for (const [raw, role, at] of [[fixture.buyerBundle, "buyer", fixture.locators.buyer], [fixture.sellerBundle, "seller", fixture.locators.seller]] as const) {
    const scope = signedScope(raw, "bundle");
    delete scope.bundleVersion;
    Object.assign(scope, { faultBundleVersion: "1", faultedParty: "orchestrator", outcome: "failed-counterparty" });
    // A party may also orchestrate; full standing still requires every distinct signer.
    scope.parties = [...scope.parties as Obj[], { role: "orchestrator", primaryClaim: dids[0], bundleHash: "a".repeat(64) }];
    const copy = { ...scope, signatures: [await sign(scope, "bundle", 0, true), await sign(scope, "bundle", 1, true)], anchoredByRole: role };
    maps.set(at, copy); copies.push(copy);
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") {
      const call = JSON.parse(String(init.body)).params?.[0];
      return Response.json({ result: 200, response: await readNativeFixture(call.message, call.data) });
    }
    const data = maps.get(String(input).split("/").pop() ?? "");
    return data ? Response.json({ success: true, owner: `0x${dids[1].slice(-64)}`, programName: OPAQUE_PROGRAM_NAME, acl: { mode: "public" }, data })
      : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
  };
  try {
    const record = await indexRegistration({ primaryClaim: dids[1], displayName: "seller", listingAnchors: [fixture.locators.listing],
      deals: [registeredDeal("orchestrator-neutral", fixture.locators.buyer, fixture.locators.seller)],
      bundleBindings: [await bindingFor("orchestrator-neutral", "buyer", fixture.locators.buyer, copies[0], 0), await bindingFor("orchestrator-neutral", "seller", fixture.locators.seller, copies[1], 1)] }, undefined, async () => []);
    assert.equal(record.deals[0].refsVerified, true);
    assert.equal(record.deals[0].orchestratorFaultNeutral, true);
    assert.deepEqual([record.reputation.bundleCount, record.reputation.completionRate, record.reputation.counterpartyFaultRate, record.reputation.counterpartyAdjustedCompletionRate], [1, null, null, null]);
  } finally { globalThis.fetch = originalFetch; }
});

test("DV-1 rejects malformed Unicode substitution against a valid replacement-character payload hash", async () => {
  const fixture = await vector("\ufffd");
  const deps = { readSettlementNode: readNativeFixture, read: async (at: string) => maps.get(at) ?? null,
    readAnchorRecord: paymentAnchorRecord, resolveListing: async () => ({ locator: locator(1), raw: fixture.listing }) };
  assert.equal((await buildCurrentEvidenceGraph(locator(5), deps)).ok, true);
  for (const report of ["\ud800", "\ud801"]) {
    const graph = await buildCurrentEvidenceGraph(locator(5), { ...deps,
      readAnchorRecord: async (at) => at === locator(61)
        ? { data: { report }, programName: OPAQUE_PROGRAM_NAME, acl: { mode: "public" } }
        : paymentAnchorRecord(at) });
    assert.equal(graph.ok, false);
    assert.equal(graph.refsVerified, false);
  }
});

test("PB-2 withholds completion and volume when a confirmed bound payout bypasses the seller", async () => {
  const fixture = await payeeBoundVector("unrelated-native-payee");
  const scope = signedScope(fixture.agreement, "agreement");
  ((scope.terms as Obj).payoutBindings as Obj[])[0].payeeAddress = `0x${"e".repeat(64)}`;
  await installAgreement(fixture, scope);
  const buyer = maps.get(fixture.locators.buyer)!; const seller = maps.get(fixture.locators.seller)!;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") {
      const call = JSON.parse(String(init.body)).params?.[0];
      if (["getTxByHash", "getBlockByNumber"].includes(call?.message)) return Response.json({ result: 200, response: await readNativeFixture(call.message, call.data) });
    }
    const data = maps.get(String(input).split("/").pop() ?? "");
    return data ? Response.json({ success: true, owner: `0x${dids[1].slice(-64)}`, programName: OPAQUE_PROGRAM_NAME, acl: { mode: "public" }, data })
      : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
  };
  try {
    const record = await indexRegistration({ primaryClaim: dids[1], displayName: "seller", listingAnchors: [fixture.locators.listing],
      deals: [registeredDeal("unrelated-native-payee", fixture.locators.buyer, fixture.locators.seller)],
      bundleBindings: [await bindingFor("unrelated-native-payee", "buyer", fixture.locators.buyer, buyer, 0),
        await bindingFor("unrelated-native-payee", "seller", fixture.locators.seller, seller, 1)],
    }, undefined, async () => []);
    assert.equal(record.deals[0].refsVerified, false);
    assert.equal(record.deals[0].reputationEligible, false);
    assert.equal(record.reputation.completed, 0);
    assert.deepEqual(record.reputation.observedTransactionalVolume, []);
  } finally { globalThis.fetch = originalFetch; }
});

// DACS-3 SE-8 / DACS-1: a procurement listing is published by the session's buyer, so the supplier
// scored as agreement seller never holds it. Each fixture listing below is anchored by its signer.
test("a buyer-published procurement listing credits its supplier's verified completion and volume", async () => {
  /** Re-publish the fixture's listing as `publisher`, editing its scope, and re-pin both bundles and the agreement. */
  const republish = async (fixture: Awaited<ReturnType<typeof vector>>, publisher: number, change: (scope: Obj) => void, pattern = "fixed-price") => {
    const scope = signedScope(fixture.listing, "listing");
    const identity: Obj = { bundleVersion: "1", presentedBy: dids[publisher], presentedAt: 1, claims: [{ ref: dids[publisher] }] };
    const presentation = Buffer.from(await ed25519Sign(Buffer.from(`dacs-bundle-presentation:v1:${contentHash(identity)}`), privateKeyFromSeed(seeds[publisher]))).toString("hex");
    scope.seller = { displayName: "publisher", identity: { ...identity, presentation: { kind: "per-claim", signatures: [{ ref: dids[publisher], signature: presentation }] } } };
    change(scope);
    fixture.listing = { ...scope, signature: await sign(scope, "listing", publisher) };
    maps.set(fixture.locators.listing, fixture.listing);
    assert.notEqual(await verifyListing(fixture.listing), null);
    const listingRef = { listingId: "svc", version: 1, contentHash: artifactHash(fixture.listing, "listing") };
    for (const field of ["buyerBundle", "sellerBundle"] as const) {
      const bundle = signedScope(fixture[field], "bundle");
      bundle.listingRef = listingRef;
      bundle.phaseSummary = (bundle.phaseSummary as Obj[]).map((phase, index) => ({ ...phase, kind: (scope.pipeline as Obj[])[index].kind }));
      fixture[field] = { ...bundle, anchoredByRole: fixture[field].anchoredByRole };
    }
    await installAgreement(fixture, { ...signedScope(fixture.agreement, "agreement"), listingRef, derivedFromPattern: pattern });
  };
  const asProcurement = (scope: Obj) => {
    scope.pricing = { kind: "auction", selectionRule: "lowest-price", reservePrice: { amount: "2", currency: "DEM" } };
    (scope.pipeline as Obj[])[0] = { kind: "negotiate-sealed-envelope-procurement",
      parameters: { commitDeadline: 1, revealWindow: 60, selectionRule: "lowest-price", auctionMode: "procurement" } };
  };
  const index = async (fixture: Awaited<ReturnType<typeof vector>>, jobId: string, scored: number, options: {
    ownListings?: boolean; publisherAnchors?: string[]; listingOwner?: number; listingPublisher?: number;
  } = {}) => {
    const publisher = options.listingPublisher ?? 0;
    const bundleBindings = [await bindingFor(jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
      await bindingFor(jobId, "seller", fixture.locators.seller, fixture.sellerBundle, 1)];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (init?.method === "POST") {
        const call = JSON.parse(String(init.body)).params?.[0];
        return Response.json({ result: 200, response: await readNativeFixture(call.message, call.data) });
      }
      const at = String(input).split("/").pop() ?? "";
      const data = maps.get(at);
      // The supplier anchors the session artifacts; the listing's publisher anchors the listing.
      const owner = at === fixture.locators.listing ? options.listingOwner ?? publisher : 1;
      return data ? Response.json({ success: true, owner: `0x${dids[owner].slice(-64)}`, programName: OPAQUE_PROGRAM_NAME, acl: { mode: "public" }, data })
        : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
    };
    try {
      return await indexRegistration({ primaryClaim: dids[scored], displayName: "scored", listingAnchors: options.ownListings ? [fixture.locators.listing] : [],
        deals: [registeredDeal(jobId, fixture.locators.buyer, fixture.locators.seller)], bundleBindings }, undefined, async () => [], undefined, undefined,
        (claim) => claim === dids[publisher] ? options.publisherAnchors ?? [fixture.locators.listing] : []);
    } finally { globalThis.fetch = originalFetch; }
  };
  const credited = (record: Awaited<ReturnType<typeof index>>, name: string) => {
    assert.equal(record.deals[0].refsVerified, true, name);
    assert.equal(record.deals[0].reputationEligible, true, name);
    assert.equal(record.deals[0].sellerOutcome, "completed", name);
    assert.equal(record.reputation.completed, 1, name);
    assert.deepEqual(record.reputation.observedTransactionalVolume, [{ currency: "DEM", amount: "1.25" }], name);
  };
  const uncounted = (record: Awaited<ReturnType<typeof index>>, name: string) => {
    assert.equal(record.deals[0].refsVerified, false, name);
    assert.equal(record.deals[0].reputationEligible, false, name);
    assert.equal(record.reputation.completed, 0, name);
    assert.deepEqual(record.reputation.observedTransactionalVolume, [], name);
  };

  // Demand-mode control: the supplier publishes its own listing and holds it.
  const demand = await vector("demand-control", 1200);
  credited(await index(demand, "demand-control", 1, { ownListings: true, listingPublisher: 1, publisherAnchors: [] }), "demand control");

  const procurement = await vector("procurement-job", 1100);
  await republish(procurement, 0, asProcurement, "sealed-envelope");
  // The supplier, scored as agreement seller, is credited from the buyer's own owner-bound listing,
  // which does not become one of the supplier's offers.
  const supplier = await index(procurement, "procurement-job", 1);
  credited(supplier, "supplier");
  assert.equal(supplier.primaryClaim, dids[1]);
  assert.deepEqual(supplier.listings, []);
  assert.equal(supplier.deals[0].category, "services.test");
  // The publishing buyer holds the listing but is never scored as the session's seller.
  const publisher = await index(procurement, "procurement-job", 0, { ownListings: true });
  uncounted(publisher, "publisher scored as seller");
  assert.equal(publisher.listings.length, 1);
  // Without the publisher's own owner-bound anchor, the listing stays unresolved and the session uncounted.
  uncounted(await index(procurement, "procurement-job", 1, { publisherAnchors: [] }), "no publisher anchors");
  uncounted(await index(procurement, "procurement-job", 1, { listingOwner: 1 }), "listing anchored by another wallet");
  const others = Array.from({ length: MAX_PUBLISHER_LISTING_READS }, (_, n) => locator(1300 + n));
  uncounted(await index(procurement, "procurement-job", 1, { publisherAnchors: [...others, procurement.locators.listing] }), "over the read bound");
  credited(await index(procurement, "procurement-job", 1, { publisherAnchors: [...others.slice(1), procurement.locators.listing] }), "at the read bound");

  // A buyer-published listing that is not a procurement cannot cast its buyer as publisher (check 8).
  const misdirected = await vector("misdirected-demand", 1400);
  await republish(misdirected, 0, () => {});
  uncounted(await index(misdirected, "misdirected-demand", 1), "buyer-published demand listing");
  // A procurement published by the agreement's seller casts its publisher as seller (check 8, SE-8).
  const sellerPublished = await vector("seller-published-procurement", 1500);
  await republish(sellerPublished, 1, asProcurement, "sealed-envelope");
  assert.equal((await graphAt(sellerPublished.locators.buyer, sellerPublished.listing, sellerPublished.locators.listing)).reason,
    "agreement fails listing conformance check: role-direction");
  uncounted(await index(sellerPublished, "seller-published-procurement", 1, { ownListings: true, listingPublisher: 1, publisherAnchors: [] }),
    "seller-published procurement");

  // Batch indexing and immediate refresh share every known publisher's anchors.
  const procurementAgain = await vector("procurement-job", 1100);
  await republish(procurementAgain, 0, asProcurement, "sealed-envelope");
  const store = await import("../src/catalog/store.js");
  const { reindexAll } = await import("../src/catalog/reindexCore.js");
  const priorState = store.loadScanState(); const priorRegs = store.loadRegistrations(); const priorDomains = store.loadDomains();
  const priorCatalog = store.loadCatalog();
  const emptyCatalog = { catalogVersion: "1" as const, generatedAt: 0, sellers: [] };
  const bundleBindings = [await bindingFor("procurement-job", "buyer", procurementAgain.locators.buyer, procurementAgain.buyerBundle, 0),
    await bindingFor("procurement-job", "seller", procurementAgain.locators.seller, procurementAgain.sellerBundle, 1)];
  const supplierRegistration = { primaryClaim: dids[1], displayName: "supplier", listingAnchors: [],
    deals: [registeredDeal("procurement-job", procurementAgain.locators.buyer, procurementAgain.locators.seller)], bundleBindings };
  let listingOwner = 0;
  const requestedAnchors: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") {
      const call = JSON.parse(String(init.body)).params?.[0];
      if (["getTxByHash", "getBlockByNumber"].includes(call?.message)) return Response.json({ result: 200, response: await readNativeFixture(call.message, call.data) });
      return Response.json({ result: 200, response: [] });
    }
    const at = new URL(String(input)).pathname.split("/").pop() ?? "";
    requestedAnchors.push(at);
    const data = maps.get(at);
    return data ? Response.json({ success: true, owner: `0x${dids[at === procurementAgain.locators.listing ? listingOwner : 1].slice(-64)}`, programName: OPAQUE_PROGRAM_NAME, acl: { mode: "public" }, data })
      : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
  };
  try {
    store.saveDomains([]);
    store.saveRegistrations([supplierRegistration]);
    store.saveCatalog(emptyCatalog);
    store.saveScanState({ ...priorState, lastSeenTxId: 0, lastChainTip: 0, listings: { [procurementAgain.locators.listing]: `0x${dids[0].slice(-64)}` },
      deals: {}, bundleBindings: {}, bundleBindingOverflow: [] });
    credited(await indexRegistration(supplierRegistration, undefined, async () => []), "scan-state publisher anchors");
    // A third party can register unsigned candidates for an unregistered buyer.
    // Those candidates cannot consume its suppliers' publisher read budget.
    const squatter = { primaryClaim: dids[0], displayName: "squatter", listingAnchors: others };
    assert.equal(parseRegistration(squatter).ok, true);
    store.saveRegistrations([squatter, supplierRegistration]);
    requestedAnchors.length = 0;
    credited(await indexRegistration(supplierRegistration, undefined, async () => []), "unsigned squatter before batch");
    assert.equal(requestedAnchors.some((anchor) => others.includes(anchor)), false, "trusted tuple resolves without reading unsigned candidates");
    await reindexAll({ log: () => {}, resolveIdentities: async () => [] });
    credited(store.loadCatalog().sellers.find((seller) => seller.primaryClaim === dids[1])!, "unsigned squatter after batch");
    credited(await indexRegistration(supplierRegistration, undefined, async () => []), "unsigned squatter after immediate refresh");
    store.saveScanState({ ...priorState, lastSeenTxId: 0, lastChainTip: 0, listings: {}, deals: {}, bundleBindings: {}, bundleBindingOverflow: [] });
    uncounted(await indexRegistration(supplierRegistration, undefined, async () => []), "no discovered publisher anchors");
    const buyerRegistration = { primaryClaim: dids[0], displayName: "buyer", listingAnchors: [procurementAgain.locators.listing] };
    // Unsigned registration is a supported discovery path when the passive scan
    // has missed the buyer. The listing itself still has to bind to its owner.
    assert.equal(parseRegistration(buyerRegistration).ok, true);
    store.saveRegistrations([buyerRegistration, supplierRegistration]);
    credited(await indexRegistration(supplierRegistration, undefined, async () => []), "unsigned registered-only publisher before batch");
    await reindexAll({ log: () => {}, resolveIdentities: async () => [] });
    const unsignedSupplier = store.loadCatalog().sellers.find((seller) => seller.primaryClaim === dids[1])!;
    credited(unsignedSupplier, "unsigned registered-only publisher after batch");
    credited(await indexRegistration(supplierRegistration, unsignedSupplier, async () => []), "unsigned registered-only publisher after immediate refresh");
    assert.deepEqual(Object.keys(store.loadScanState().listings), [], "no passive discovery supplies the registered-only listing");

    listingOwner = 1;
    uncounted(await indexRegistration(supplierRegistration, undefined, async () => []), "unsigned candidate with a different chain owner");
    listingOwner = 0;
    maps.set(procurementAgain.locators.listing, { ...procurementAgain.listing, listingId: "changed" });
    uncounted(await indexRegistration(supplierRegistration, undefined, async () => []), "unsigned candidate with tampered bytes");
    const unrelated = { ...signedScope(procurementAgain.listing, "listing"), listingId: "unrelated" };
    maps.set(procurementAgain.locators.listing, { ...unrelated, signature: await sign(unrelated, "listing", 0) });
    assert.notEqual(await verifyListing(maps.get(procurementAgain.locators.listing)!), null);
    uncounted(await indexRegistration(supplierRegistration, undefined, async () => []), "unsigned candidate with a different signed tuple");
    maps.set(procurementAgain.locators.listing, procurementAgain.listing);

    store.saveScanState({ ...store.loadScanState(), listings: { [others[0]]: `0x${dids[0].slice(-64)}` } });
    credited(await indexRegistration(supplierRegistration, undefined, async () => []), "trusted candidates miss the pinned tuple before unsigned fallback");
    store.saveScanState({ ...store.loadScanState(), listings: {} });
    store.saveRegistrations([{ ...buyerRegistration, listingAnchors: [...others, procurementAgain.locators.listing] }, supplierRegistration]);
    requestedAnchors.length = 0;
    uncounted(await indexRegistration(supplierRegistration, undefined, async () => []), "unsigned candidates over the fallback read bound");
    assert.equal(requestedAnchors.some((anchor) => others.includes(anchor) || anchor === procurementAgain.locators.listing), false,
      "over-budget unsigned candidates cause no listing reads");
    store.saveRegistrations([{ ...buyerRegistration, listingAnchors: [...others.slice(1), procurementAgain.locators.listing] }, supplierRegistration]);
    credited(await indexRegistration(supplierRegistration, undefined, async () => []), "unsigned candidates at the fallback read bound");

    // Keep the signed-registration control and combined trusted-source budget.
    const signedAt = Date.now();
    const message = registrationMessage(buyerRegistration, signedAt);
    const signature = Buffer.from(await ed25519Sign(Buffer.from(message), privateKeyFromSeed(seeds[0]))).toString("base64url");
    store.saveRegistrations([{ ...buyerRegistration, ownerSignature: { message, signature, signedAt } }, supplierRegistration]);
    credited(await indexRegistration(supplierRegistration, undefined, async () => []), "registered-only publisher before batch");
    await reindexAll({ log: () => {}, resolveIdentities: async () => [] });
    const sellers = store.loadCatalog().sellers;
    const reindexedSupplier = sellers.find((seller) => seller.primaryClaim === dids[1])!;
    credited(reindexedSupplier, "reindexed supplier");
    assert.equal(sellers.find((seller) => seller.primaryClaim === dids[0])!.listings.length, 1);
    credited(await indexRegistration(supplierRegistration, reindexedSupplier, async () => []),
      "registered-only publisher after immediate refresh");

    // The registered anchor still works without a cached buyer listing. All discovery
    // sources share the same read bound, and duplicates do not spend it twice.
    store.saveCatalog(emptyCatalog);
    const discovered = Object.fromEntries(others.map((anchor) => [anchor, `0x${dids[0].slice(-64)}`]));
    const emptyState = { ...priorState, lastSeenTxId: 0, lastChainTip: 0, listings: {}, publisherListingDiscoveries: {}, deals: {}, bundleBindings: {}, bundleBindingOverflow: [] };
    store.saveScanState({ ...emptyState, listings: discovered });
    uncounted(await indexRegistration(supplierRegistration, reindexedSupplier, async () => []), "combined sources over the read bound");
    delete discovered[others[0]];
    discovered[procurementAgain.locators.listing] = `0x${dids[0].slice(-64)}`;
    store.saveScanState({ ...emptyState, listings: discovered });
    credited(await indexRegistration(supplierRegistration, reindexedSupplier, async () => []), "combined sources deduplicate at the read bound");

    // Only an authenticated well-known index introduces new catalog anchors.
    store.saveScanState(emptyState);
    store.saveRegistrations([supplierRegistration]);
    store.saveCatalog(emptyCatalog);
    store.saveDomains(["buyer.example"]);
    const { crawlDomain, wellKnownWithdrawalMessage } = await import("../src/catalog/wellknown.js");
    const indexRaw = JSON.stringify({ indexVersion: "1", generatedAt: 123, seller: dids[0], listings: [{ listingId: "svc", version: 1,
      contentHash: artifactHash(procurementAgain.listing, "listing"), anchor: { kind: "storage-program", locator: procurementAgain.locators.listing } }] });
    const indexHash = sha256Hex(indexRaw);
    const crawl = (publisherSignature?: string) => crawlDomain("buyer.example", { validateUrl: async () => ({} as never), fetchJson: async (url) => {
      const raw = new URL(url).pathname === "/.well-known/agent.json"
        ? JSON.stringify({ dacs: { dacsVersion: "1", listings: { indexUrl: "https://buyer.example/.well-known/dacs/listings.json", indexHash: `sha256-${indexHash}`, publisherSignature } } })
        : indexRaw;
      return { raw, body: JSON.parse(raw) };
    } });
    const unsigned = await crawl();
    assert.ok(!("error" in unsigned));
    assert.equal(unsigned.withdrawalAuthenticated, false);
    await reindexAll({ log: () => {}, resolveIdentities: async () => [], crawlWellKnown: async () => ({ agents: [unsigned], errors: [] }) });
    uncounted(store.loadCatalog().sellers.find((seller) => seller.primaryClaim === dids[1])!, "unsigned discovery");
    uncounted(await indexRegistration(supplierRegistration, undefined, async () => []), "unsigned discovery after immediate refresh");
    const publisherSignature = Buffer.from(await ed25519Sign(Buffer.from(wellKnownWithdrawalMessage("buyer.example", indexHash)), privateKeyFromSeed(seeds[0]))).toString("base64url");
    const authenticated = await crawl(publisherSignature);
    assert.ok(!("error" in authenticated));
    assert.equal(authenticated.withdrawalAuthenticated, true);
    await reindexAll({ log: () => {}, resolveIdentities: async () => [], crawlWellKnown: async () => ({ agents: [authenticated], errors: [] }) });
    const wellKnownSupplier = store.loadCatalog().sellers.find((seller) => seller.primaryClaim === dids[1])!;
    credited(wellKnownSupplier, "well-known-only publisher after batch");
    assert.equal(Object.keys(store.loadScanState().listings).length, 0);
    assert.equal(store.loadRegistrations().some((reg) => reg.primaryClaim === dids[0]), false);
    credited(await indexRegistration(supplierRegistration, wellKnownSupplier, async () => []), "well-known-only publisher after immediate refresh");

    // Reviewer outage probe: historical discovery survives catalog replacement
    // even though the failed crawl cannot publish the buyer's current offers.
    const outage = { log: () => {}, resolveIdentities: async () => [],
      crawlWellKnown: async () => ({ agents: [], errors: [{ domain: "buyer.example", error: "temporary outage" }] }) };
    await reindexAll(outage);
    let batchSupplier = store.loadCatalog().sellers.find((seller) => seller.primaryClaim === dids[1])!;
    credited(batchSupplier, "crawl outage after batch");
    assert.equal(store.loadCatalog().sellers.some((seller) => seller.primaryClaim === dids[0]), false);
    credited(await indexRegistration(supplierRegistration, batchSupplier, async () => []), "crawl outage after immediate refresh");
    await reindexAll(outage);
    credited(store.loadCatalog().sellers.find((seller) => seller.primaryClaim === dids[1])!, "repeated crawl outage");

    // Reviewer pending-withdrawal probe: authenticated discovery must survive
    // even on its first crawl, when no public buyer listing is ever saved.
    store.saveScanState(emptyState);
    store.saveCatalog(emptyCatalog);
    const listingHash = artifactHash(procurementAgain.listing, "listing");
    const pendingMarker = locator(16000);
    maps.set(pendingMarker, { unreadable: true });
    const normalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => String(input).endsWith(pendingMarker)
      ? Response.json({ success: false, errorCode: "UNAVAILABLE" }, { status: 503 }) : normalFetch(input, init);
    store.admitRevocationCandidates(listingHash, [{ locator: pendingMarker }]);
    await reindexAll({ log: () => {}, resolveIdentities: async () => [], crawlWellKnown: async () => ({ agents: [authenticated], errors: [] }) });
    assert.equal(store.hasPendingRevocationCandidates(listingHash), true);
    assert.equal(store.loadCatalog().sellers.find((seller) => seller.primaryClaim === dids[0])!.listings.length, 0);
    batchSupplier = store.loadCatalog().sellers.find((seller) => seller.primaryClaim === dids[1])!;
    credited(batchSupplier, "pending withdrawal after batch");
    credited(await indexRegistration(supplierRegistration, batchSupplier, async () => []), "pending withdrawal after immediate refresh");
    globalThis.fetch = normalFetch;

    // A prior catalog is presentation, not discovery. Its removed rows cannot
    // exhaust the current pass's budget, even on the first replacement pass.
    const staleCatalog = store.loadCatalog();
    const buyerRow = staleCatalog.sellers.find((seller) => seller.primaryClaim === dids[0])!;
    buyerRow.listings = others.map((anchor) => ({ ...publisher.listings[0], anchor: { kind: "storage-program", locator: anchor } }));
    store.saveCatalog(staleCatalog);
    await reindexAll({ log: () => {}, resolveIdentities: async () => [], crawlWellKnown: async () => ({ agents: [authenticated], errors: [] }) });
    credited(store.loadCatalog().sellers.find((seller) => seller.primaryClaim === dids[1])!, "stale prior catalog anchors");

    // Successful domain indexes replace old hints rather than accumulating
    // withdrawn anchors; removing a domain retires its hints too.
    store.saveScanState({ ...store.loadScanState(), publisherListingDiscoveries: {
      "https://buyer.example": { publisherClaim: dids[0], listingAnchors: others },
    } });
    await reindexAll({ log: () => {}, resolveIdentities: async () => [], crawlWellKnown: async () => ({ agents: [authenticated], errors: [] }) });
    assert.deepEqual(store.loadScanState().publisherListingDiscoveries?.["https://buyer.example"], {
      publisherClaim: dids[0], listingAnchors: [procurementAgain.locators.listing],
    }, "successful crawl replaces the retained domain's hints");
    credited(store.loadCatalog().sellers.find((seller) => seller.primaryClaim === dids[1])!, "fresh authenticated index replaces old hints");

    // A cached discovery never substitutes for current owner/signature/hash checks.
    listingOwner = 1;
    uncounted(await indexRegistration(supplierRegistration, wellKnownSupplier, async () => []), "cached listing with a different chain owner");
    listingOwner = 0;
    maps.set(procurementAgain.locators.listing, { ...procurementAgain.listing, listingId: "changed" });
    uncounted(await indexRegistration(supplierRegistration, wellKnownSupplier, async () => []), "cached listing with tampered bytes");
    maps.delete(procurementAgain.locators.listing);
    uncounted(await indexRegistration(supplierRegistration, wellKnownSupplier, async () => []), "cached listing missing on chain");
    store.saveDomains([]);
    await reindexAll({ log: () => {}, resolveIdentities: async () => [] });
    assert.deepEqual(Object.keys(store.loadScanState().publisherListingDiscoveries), [], "removed domains retire discovery hints");
  } finally {
    globalThis.fetch = originalFetch;
    store.saveRegistrations(priorRegs); store.saveDomains(priorDomains); store.saveScanState(priorState);
    store.saveCatalog(priorCatalog);
  }
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
      if (accepted) assert.match(graph.reason ?? "", /semantic settlement verification is unsupported/);
      else assert.equal(graph.reason, `agreement fails listing conformance check: ${currency === "USDC" ? "price" : "currency"}`);
    }
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
          // The DEM reserve fixes the agreed currency; without one no pay-dem session is admitted (§10.5.1).
          : { kind: "auction", selectionRule: "lowest-price", reservePrice: { amount: "10", currency: "DEM" } };
        fixture.listing = { ...listingScope, signature: await sign(listingScope, "listing", 1) };
        maps.set(fixture.locators.listing, fixture.listing);
        assert.ok(await verifyListing(fixture.listing));
        const listingRef = { listingId: "svc", version: 1, contentHash: artifactHash(fixture.listing, "listing") };
        for (const bundle of [fixture.buyerBundle, fixture.sellerBundle]) Object.assign(bundle, { listingRef, phaseSummary: phaseSummaryOf(fixture.listing) });
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
    for (const bundle of [fixture.buyerBundle, fixture.sellerBundle]) Object.assign(bundle, { listingRef, phaseSummary: phaseSummaryOf(fixture.listing) });
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

test("RFQ fallback requires signed opt-in and the exact decimal center, and leaves RFQ agreements without it unrestricted", async () => {
  // DEM has 9 decimals; at this magnitude a binary float cannot tell the center from its neighbour.
  const center = "1000000000.000000001";
  for (const profile of ["legacy", "payee-bound"] as const) {
    for (const [fallback, pattern, amount, currency, rejection] of [
      [true, "fixed-price", center, "DEM", null],
      [false, "fixed-price", center, "DEM", "pattern"],
      [undefined, "fixed-price", center, "DEM", "pattern"],
      [true, "fixed-price", "900000000", "DEM", "price"],
      [true, "fixed-price", "1000000000.000000002", "DEM", "price"],
      [true, "fixed-price", center, "EUR", "currency"],
      [true, "sealed-envelope", center, "DEM", "pattern"],
      [true, "rfq", "900000000", "DEM", null],
      [false, "rfq", "900000000", "DEM", null],
      [undefined, "rfq", "900000000", "DEM", null],
    ] as const) {
      const accepted = rejection === null;
      const fixture = profile === "legacy" ? await vector() : await payeeBoundVector();
      const listingScope = signedScope(fixture.listing, "listing");
      const parameters: Obj = { maxTurns: 6, timeoutSec: 300 };
      if (fallback !== undefined) parameters.fixedPriceFallback = fallback;
      (listingScope.pipeline as Obj[])[0] = { kind: "negotiate-rfq", parameters };
      listingScope.pricing = { kind: "negotiable", bandCenter: { amount: center, currency: "DEM" }, minPct: 20, maxPct: 20 };
      fixture.listing = { ...listingScope, signature: await sign(listingScope, "listing", 1) };
      maps.set(fixture.locators.listing, fixture.listing);
      assert.ok(await verifyListing(fixture.listing));
      const listingRef = { listingId: "svc", version: 1, contentHash: artifactHash(fixture.listing, "listing") };
      for (const bundle of [fixture.buyerBundle, fixture.sellerBundle]) Object.assign(bundle, { listingRef, phaseSummary: phaseSummaryOf(fixture.listing) });
      if (currency === "DEM") await repay(fixture, amount);
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
        // §10.5.1: once the listing enables the fallback, any session may settle on a fixed-price
        // agreement this profile cannot verify, so its RFQ agreements are excluded with it.
        assert.equal(graph.ok, accepted && pattern === "rfq" && fallback !== true, label);
        assert.equal(graph.refsVerified, accepted && pattern === "rfq" && fallback !== true, label);
        if (accepted && pattern === "fixed-price") assert.match(graph.reason ?? "", /semantic settlement verification is unsupported/, label);
        if (accepted && pattern === "rfq" && fallback === true) {
          assert.equal(graph.reason, "session verification is indeterminate for every outcome on this listing: fixed-price agreements on negotiable listings have no settlement semantics", label);
        }
        if (!accepted) assert.equal(graph.reason, `agreement fails listing conformance check: ${rejection}`, label);
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
      for (const bundle of [fixture.buyerBundle, fixture.sellerBundle]) Object.assign(bundle, { listingRef, phaseSummary: phaseSummaryOf(fixture.listing) });
      const agreementScope = signedScope(fixture.agreement, "agreement");
      agreementScope.listingRef = listingRef;
      agreementScope.derivedFromPattern = pattern;
      // Both patterns carry the metered usage (1 call at 1.25 DEM); only the pattern differs.
      agreementScope.terms = { ...(agreementScope.terms as Obj), meteredQuantity: { quantity: "1", unit: "call" } };
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
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") {
      const call = JSON.parse(String(init.body)).params?.[0];
      if (["getTxByHash", "getBlockByNumber"].includes(call?.message)) return Response.json({ result: 200, response: await readNativeFixture(call.message, call.data) });
    }
    const data = maps.get(String(input).split("/").pop() ?? "");
    return data ? Response.json({ success: true, owner: `0x${dids[1].slice(-64)}`, acl: { mode: "public" }, data })
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
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") {
      const call = JSON.parse(String(init.body)).params?.[0];
      if (["getTxByHash", "getBlockByNumber"].includes(call?.message)) return Response.json({ result: 200, response: await readNativeFixture(call.message, call.data) });
    }
    const at = String(input).split("/").pop()!;
    const data = maps.get(at);
    return data ? Response.json({ success: true, data, owner: `0x${dids[1].slice(-64)}`, acl: { mode: "public" } })
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
