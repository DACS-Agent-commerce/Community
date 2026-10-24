import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { artifactHash, buildCurrentEvidenceGraph, signedScope } from "../../src/catalog/evidenceGraph.js";
import { logicalBundleAddress } from "../../src/catalog/bundleBinding.js";
import type { BundleBinding, RegisteredDeal } from "../../src/catalog/types.js";

export type Obj = Record<string, unknown>;
export const seeds = [11, 12, 13].map((byte) => Uint8Array.from(Buffer.alloc(32, byte)));
export const dids = seeds.map((seed) => `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`);
export const locator = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;
export const maps = new Map<string, Obj>();
export const sign = async (raw: Obj, kind: "listing" | "agreement" | "evidence" | "rating" | "bundle" | "verify-result" | "composite", signer: number, party = false) => {
  const hash = artifactHash(raw, kind);
  const prefixes = { listing: "dacs-listing:v1:", agreement: "dacs-agreement:v1:", evidence: "dacs-evidence:v1:", rating: "dacs-rating:v1:", bundle: "dacs-bundle:v1:", "verify-result": "dacs-verifyresult:v1:", composite: "dacs-composite:v1:" };
  const prefix = kind === "agreement" && raw.payeeBoundAgreementVersion === "1"
    ? "dacs-payee-bound-agreement:v1:"
    : kind === "bundle" && raw.faultBundleVersion === "1"
      ? "dacs-fault-bundle:v1:"
      : prefixes[kind];
  // Current artifacts carry CORE §B.7 SIG-6 base64url signature values.
  const value = Buffer.from(await ed25519Sign(Buffer.from(prefix + hash), privateKeyFromSeed(seeds[signer]))).toString("base64url");
  return party ? { party: dids[signer], algorithm: "ed25519", value } : { signer: dids[signer], algorithm: "ed25519", value };
};
export const ref = (at: string, raw: Obj, kind: Parameters<typeof artifactHash>[1], extra: Obj = {}) => ({
  anchor: { kind: "storage-program", locator: at }, contentHash: artifactHash(raw, kind), ...extra,
});

const SELF_SIGNED_DELIVERABLE: Obj = { kind: "attested-payload", payloadFormat: "application/json", verificationMethod: { kind: "self-signed" } };

export async function vector(jobId = "job-1", offset = 0, presentedBy = dids[1], deliverable: Obj = SELF_SIGNED_DELIVERABLE) {
  maps.clear();
  const at = (n: number) => locator(offset + n);
  const listingScope: Obj = {
    dacsVersion: "1", listingVersion: 1, listingId: "svc", requiredCapabilities: ["SR-2"],
    seller: { identity: { bundleVersion: "1", presentedBy, presentedAt: 1, claims: [{ ref: presentedBy }], presentation: { kind: "per-claim", signatures: [] } }, displayName: "seller" },
    offering: { title: "test", description: "test service", category: "services.test", tags: [], deliverable },
    buyerRequirement: { requirementVersion: "1", required: [], preferredPresentation: "any" },
    pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "pay-dem", parameters: { rail: "pay-dem" } }, { kind: "deliver-attested-payload" }],
    pricing: { kind: "fixed", price: { amount: "1.25", currency: "DEM", unit: "job" } }, acceptedRails: [{ railId: "pay-dem" }], terms: {}, validity: { notBefore: 1 },
  };
  // Listing verifier requires a presentation signature for the seller claim.
  const identity = (listingScope.seller as Obj).identity as Obj;
  const identityScope = { ...identity }; delete (identityScope as Obj).presentation;
  const identitySig = Buffer.from(await ed25519Sign(Buffer.from(`dacs-bundle-presentation:v1:${contentHash(identityScope)}`), privateKeyFromSeed(seeds[1]))).toString("base64url");
  (identity.presentation as Obj).signatures = [{ ref: presentedBy, signature: identitySig }];
  const listing: Obj = { ...listingScope, signature: await sign(listingScope, "listing", 1) }; maps.set(at(1), listing);
  const listingRef = { listingId: "svc", version: 1, contentHash: artifactHash(listing, "listing") };
  const agreementScope: Obj = { agreementVersion: "1", jobId, listingRef, derivedFromPattern: "fixed-price",
    parties: [{ role: "buyer", primaryClaim: dids[0] }, { role: "seller", primaryClaim: dids[1] }],
    terms: {
      price: { amount: "1.25", currency: "DEM" },
      rail: { railId: "pay-dem" },
    } };
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

export async function bindingFor(
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

export async function installAgreement(
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

export async function payeeBoundVector(jobId = "payee-bound-job", offset = 0) {
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
    derivedFromPattern: "fixed-price",
    jobId,
    listingRef,
    parties: [{ role: "buyer", primaryClaim: dids[0] }, { role: "seller", primaryClaim: dids[1] }],
    terms: {
      price: { amount: "1.25", currency: "DEM" },
      rail: { railId: "pay-dem" },
      payoutBindings: [{ railId: "pay-dem", phaseIndex: 2, payeeAddress: dids[1] }],
    },
  };

  const updateListingRef = (raw: Obj) => {
    const scope = signedScope(raw, "bundle");
    scope.listingRef = listingRef;
    return { ...scope, signatures: raw.signatures, anchoredByRole: raw.anchoredByRole };
  };
  fixture.buyerBundle = updateListingRef(fixture.buyerBundle);
  fixture.sellerBundle = updateListingRef(fixture.sellerBundle);
  await installAgreement(fixture, agreementScope);
  return fixture;
}

export async function graphAt(at: string, listing: Obj, listingLocator: string) {
  return buildCurrentEvidenceGraph(at, {
    read: async (locatorValue) => maps.get(locatorValue) ?? null,
    resolveListing: async () => ({ locator: listingLocator, raw: listing }),
  });
}

export function registeredDeal(jobId: string, buyer: string, seller: string): RegisteredDeal {
  return { jobId, rail: "pay-dem", buyerBundleRef: buyer, sellerBundleRef: seller, owners: { buyer: dids[0], seller: dids[1] } };
}
