import { contentHash, stripSignature } from "@kynesyslabs/dacs/canonical";
import type { AttestationBundle } from "@kynesyslabs/dacs/artifacts";
import type { BundleVerification } from "../../vendor/dacs-sdk/dist/agent/verifyBundleCore.js";

import { bundleSignerPolicy, demosSigningIdentity } from "./bundleSignerPolicy.js";
import { verifyListing } from "./listingVerification.js";
import {
  resolvePrimaryClaimKey,
  resolveDemosPrimaryClaimKey,
  verifyPrimaryClaimSignature,
  type ResolvePrimaryClaimKey,
} from "./primaryClaimKey.js";
import { legacySignatureBytes } from "./signatureValue.js";
import type { DealRecord, RegisteredDeal } from "./types.js";

// This is the legacy SDK compatibility path. Current-profile agreement artifacts,
// including payee-bound agreements, are selected and verified by evidenceGraph.ts.
// Do not add the payee-bound domain here without also replacing the legacy SDK
// artifact shape/party checks below; the compatibility reader must fail closed.
const SEPARATORS: Record<string, string> = {
  "dacs-3-agreement": "dacs-agreement:v1:",
  "dacs-4-evidence": "dacs-evidence:v1:",
  "dacs-2-verifyresult": "dacs-composite:v1:",
};

export function hasRequiredBundleSignatures(result: BundleVerification, rawBundle: unknown): boolean {
  const bundle = result.bundle;
  if (!bundle || !rawBundle || typeof rawBundle !== "object" || Array.isArray(rawBundle)) return false;
  const raw = rawBundle as Record<string, unknown>;
  const rawSignatures = raw.signatures;
  if (raw.signature !== undefined || !Array.isArray(rawSignatures) ||
      rawSignatures.length !== result.signatures.length) return false;
  for (let index = 0; index < rawSignatures.length; index++) {
    const value = rawSignatures[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const signature = value as Record<string, unknown>;
    if (signature.algorithm !== "ed25519" || signature.party !== result.signatures[index].party ||
        typeof signature.value !== "string" || signature.value.length === 0) return false;
  }
  const valid = new Set(result.signatures.filter((s) => s.verdict === "valid").map((s) => s.party));
  return bundleSignerPolicy(bundle, valid, result.signatures.length > 0 &&
    result.signatures.every((signature) => signature.verdict === "valid"),
    { legacyDemosAliases: true });
}

/** Return the role registered for this exact copy address, if the directory knows it. */
export function registeredAnchorRole(
  bundleRef: string,
  buyerBundleRef: unknown,
  sellerBundleRef: unknown,
): "buyer" | "seller" | null {
  const ref = bundleRef.toLowerCase();
  return typeof buyerBundleRef === "string" && buyerBundleRef.toLowerCase() === ref
    ? "buyer"
    : typeof sellerBundleRef === "string" && sellerBundleRef.toLowerCase() === ref
      ? "seller"
      : null;
}

/** Bind the unhashed per-copy role to the address the directory registered for it. */
export function bundleMatchesRegisteredAnchor(
  bundle: { anchoredByRole?: unknown } | undefined,
  bundleRef: string,
  buyerBundleRef: unknown,
  sellerBundleRef: unknown,
): boolean {
  const expectedRole = registeredAnchorRole(bundleRef, buyerBundleRef, sellerBundleRef);
  return expectedRole !== null && bundle?.anchoredByRole === expectedRole;
}

/** Legacy signatures/hashes establish artifact integrity, not paid settlement.
 * No authoritative adapter exists for this profile, including native DEM. */
export function legacyPaymentProofUnavailable(bundle: BundleVerification["bundle"]): boolean {
  return bundle?.outcome === "completed" || Boolean(bundle?.settlementEvidence?.length);
}

export type BrowserDealVerdict = "strict-pass" | "limited" | "fail";

/**
 * The in-browser verdict on a legacy deal copy. Strict needs the expected parties,
 * the required signatures, strict referenced artifacts, and an anchoredByRole that
 * matches the address the directory registered for this copy. Without a registered
 * address-role binding, internally consistent evidence is only "limited".
 */
export function browserDealVerdict(input: {
  verification: BundleVerification;
  bundleRef: string;
  buyerOwner: string;
  expectedSeller?: string;
  registered: { owners: unknown; buyerBundleRef: unknown; sellerBundleRef: unknown } | null;
  signaturesOk: boolean;
  refsOk: boolean;
}): { verdict: BrowserDealVerdict; reason?: string } {
  const { verification, bundleRef, registered } = input;
  const buyer = verification.bundle?.parties.find((p) => p.role === "buyer")?.primaryClaim;
  const seller = verification.bundle?.parties.find((p) => p.role === "seller")?.primaryClaim;
  const anchorBindingAvailable = registeredAnchorRole(bundleRef, registered?.buyerBundleRef, registered?.sellerBundleRef) !== null;
  const owners = registered?.owners && typeof registered.owners === "object" &&
    !Array.isArray(registered.owners) ? registered.owners as Record<string, unknown> : null;
  const registeredPartiesMatch = typeof owners?.buyer === "string" && typeof owners.seller === "string" &&
    buyer === owners.buyer && seller === owners.seller;
  const expectedPartiesMatch = buyer === input.buyerOwner && (!input.expectedSeller || seller === input.expectedSeller) &&
    (!anchorBindingAvailable || registeredPartiesMatch);
  const anchorRoleMatches = bundleMatchesRegisteredAnchor(
    verification.bundle, bundleRef, registered?.buyerBundleRef, registered?.sellerBundleRef,
  );
  const internallyConsistent = verification.ok && expectedPartiesMatch && input.signaturesOk && input.refsOk;
  const reason = !expectedPartiesMatch
    ? "bundle parties do not match the expected buyer/seller"
    : !input.signaturesOk
      ? "required buyer/seller signatures are missing or invalid"
      : !input.refsOk
        ? "one or more referenced artifact signatures are missing or invalid"
        : !anchorBindingAvailable
          ? "the directory has no registered address-role binding for this bundle, so anchoredByRole cannot be verified"
          : !anchorRoleMatches
            ? "bundle anchoredByRole does not match its registered buyer/seller address"
            : verification.reason;
  if (internallyConsistent && anchorRoleMatches && legacyPaymentProofUnavailable(verification.bundle)) {
    return { verdict: "limited", reason: "legacy payment verification is indeterminate: authoritative settlement adapter is unavailable" };
  }
  return {
    verdict: internallyConsistent && anchorRoleMatches ? "strict-pass"
      : internallyConsistent && !anchorBindingAvailable ? "limited" : "fail",
    reason,
  };
}

/**
 * Bind a catalog-submitted deal pointer to the identities and job id covered by
 * the verified bundle signatures. Registration fields are routing hints only;
 * they must never be allowed to reassign somebody else's bundle/reputation.
 */
export function bundleMatchesRegisteredDeal(
  bundle: AttestationBundle | undefined,
  deal: RegisteredDeal,
  catalogSeller: string,
): boolean {
  if (!bundle || bundle.jobId !== deal.jobId) return false;
  const buyers = bundle.parties.filter((p) => p.role === "buyer");
  const sellers = bundle.parties.filter((p) => p.role === "seller");
  return buyers.length === 1 && sellers.length === 1 &&
    demosSigningIdentity(buyers[0].primaryClaim) !== demosSigningIdentity(sellers[0].primaryClaim) &&
    buyers[0].primaryClaim === deal.owners.buyer &&
    sellers[0].primaryClaim === deal.owners.seller &&
    sellers[0].primaryClaim === catalogSeller;
}

/**
 * DACS-5 §10.5.1 per-jobId reconciliation over one seller's verified deals.
 * One record is kept per bundle ref, and canonically equal copies of a jobId
 * collapse to one. Among divergent copies a lone fully signed one takes
 * precedence; equal standing voids the jobId (BB-6), whoever the buyers are.
 * A superseded or voided record stays listed but is never reputation-eligible.
 */
export function dedupeVerifiedDeals(deals: DealRecord[]): DealRecord[] {
  const refs = new Set<string>();
  const forms = new Set<string>();
  const unique = deals.filter((deal) => {
    if (!deal.refsVerified) return true;
    const ref = deal.buyerBundleRef.toLowerCase();
    const form = `${deal.jobId}\n${deal.bundleContentHash ?? ref}`;
    if (refs.has(ref) || forms.has(form)) return false;
    refs.add(ref);
    forms.add(form);
    return true;
  });
  const byJob = new Map<string, DealRecord[]>();
  for (const deal of unique) if (deal.refsVerified) byJob.set(deal.jobId, [...(byJob.get(deal.jobId) ?? []), deal]);
  const authoritative = new Set<DealRecord>();
  for (const copies of byJob.values()) {
    const full = copies.filter((deal) => deal.fullSignatureStanding);
    if (copies.length === 1) authoritative.add(copies[0]);
    else if (full.length === 1) authoritative.add(full[0]);
  }
  return unique.map((deal) => !deal.refsVerified || authoritative.has(deal) ? deal : { ...deal, reputationEligible: false });
}

/** Every bundle party carries a valid signature in a legacy SDK verification. */
export function legacyFullSignatureStanding(verification: BundleVerification | null | undefined): boolean {
  const parties = verification?.bundle?.parties ?? [];
  const valid = new Set((verification?.signatures ?? []).filter((signature) => signature.verdict === "valid")
    .map((signature) => demosSigningIdentity(signature.party)));
  return parties.length >= 2 && parties.every((party) => valid.has(demosSigningIdentity(party.primaryClaim)));
}

export interface ResolvedArtifact {
  kind: string;
  raw: Record<string, unknown>;
}

interface ExpectedArtifact {
  kind: string;
  id: string;
  contentHash: string;
}

function expectedArtifacts(verification: BundleVerification): ExpectedArtifact[] | null {
  const bundle = verification.bundle;
  const extended = bundle as unknown as Record<string, unknown> | undefined;
  // The pinned compatibility SDK does not resolve or report amendments/ratings.
  // A nonempty set must fail closed here instead of receiving a partial "strict"
  // verdict. The current-profile evidence graph resolves ratingRefs separately.
  if (!bundle || bundle.agreementRef.kind !== "dacs-3-agreement" ||
      bundle.settlementEvidence.some((ref) => ref.kind !== "dacs-4-evidence") ||
      bundle.vetRecords.some((ref) => ref.kind !== "dacs-2-verifyresult") ||
      [extended?.amendments, extended?.ratingRefs].some((refs) => refs !== undefined &&
        (!Array.isArray(refs) || refs.length > 0))) return null;
  const expected: ExpectedArtifact[] = [
    { kind: "dacs-3-agreement", id: bundle.agreementRef.id, contentHash: bundle.agreementRef.contentHash },
    ...bundle.settlementEvidence.map((ref) => ({ kind: "dacs-4-evidence", id: ref.id, contentHash: ref.contentHash })),
    ...bundle.vetRecords.map((ref) => ({ kind: "dacs-2-verifyresult", id: ref.id, contentHash: ref.contentHash })),
    { kind: "dacs-1-listing", id: String(bundle.listingRef.listingId), contentHash: bundle.listingRef.contentHash },
  ];
  const ids = new Set(expected.map((ref) => `${ref.kind}\n${ref.id}`));
  const hashes = new Set(expected.map((ref) => ref.contentHash));
  if (ids.size !== expected.length || hashes.size !== expected.length) return null;
  const topLevelRefs = new Set(expected.slice(1, -1).map((ref) => `${ref.kind}\n${ref.id}\n${ref.contentHash}`));
  const phases = bundle.phaseSummary as unknown as Array<Record<string, unknown>>;
  for (const phase of phases) {
    if (phase.attestationRef === undefined) continue;
    const back = phase.attestationRef;
    if (!back || typeof back !== "object" || Array.isArray(back)) return null;
    const ref = back as Record<string, unknown>;
    if (!topLevelRefs.has(`${ref.kind}\n${ref.id}\n${ref.contentHash}`)) return null;
  }
  return expected;
}

/**
 * Signature validation layered on top of the SDK's shape/hash ref checks.
 *
 * `partyClaims` is the set of primaryClaims on the bundle. It binds signer
 * IDENTITY (not just "some valid signature"):
 *  - dacs-3-agreement: buyer AND seller (named in the artifact) must sign.
 *  - dacs-4-evidence: settlement evidence is produced by the transacting
 *    parties, so at least one signer must be a bundle party.
 *  - dacs-2-verifyresult: the vetting record may be signed by an external
 *    verifier not listed as a party, so we require a valid signature but do
 *    NOT constrain the signer to the party set. Integrity is still anchored
 *    by the parent bundle's hash-binding of this ref.
 */
export async function verifyReferencedArtifactSignature(
  artifact: ResolvedArtifact,
  partyClaims: Set<string> = new Set(),
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<boolean> {
  if (artifact.kind === "dacs-1-listing") return (await verifyListing(artifact.raw, resolveKey)) !== null;
  const separator = SEPARATORS[artifact.kind];
  if (!separator) return false;
  const raw = artifact.raw;
  const scope = { ...stripSignature(raw) };
  delete scope.signatures;
  const hasPlural = raw.signatures !== undefined;
  const hasSingular = raw.signature !== undefined;
  if (hasPlural === hasSingular) return false;
  const entries = hasPlural
    ? Array.isArray(raw.signatures) ? raw.signatures : []
    : raw.signature && typeof raw.signature === "object" && !Array.isArray(raw.signature)
      ? [raw.signature] : [];
  if (entries.length === 0) return false;
  const validSigners = new Set<string>();
  const message = Buffer.from(separator + contentHash(scope), "utf8");
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const s = entry as Record<string, unknown>;
    const signer = typeof s.signer === "string" ? s.signer : typeof s.party === "string" ? s.party : null;
    if (s.algorithm !== "ed25519" || !signer || typeof s.value !== "string") return false;
    const signature = legacySignatureBytes(s.value);
    if (!signature) return false;
    const verified = await verifyPrimaryClaimSignature(
      message, signature, signer, s.algorithm, resolveKey,
    );
    if (!verified) return false;
    validSigners.add(verified.canonicalClaim);
  }
  if (artifact.kind === "dacs-3-agreement") {
    const buyer = scope.buyer;
    const seller = scope.seller;
    if (typeof buyer !== "string" || typeof seller !== "string") return false;
    const resolved = await Promise.all([
      resolvePrimaryClaimKey(buyer, "ed25519", resolveKey),
      resolvePrimaryClaimKey(seller, "ed25519", resolveKey),
    ]);
    return resolved.every((claim) => claim && validSigners.has(claim.canonicalClaim));
  }
  if (artifact.kind === "dacs-4-evidence") {
    const parties = await Promise.all([...partyClaims].map((claim) =>
      resolvePrimaryClaimKey(claim, "ed25519", resolveKey)));
    return parties.some((claim) => claim && validSigners.has(claim.canonicalClaim));
  }
  return true;
}

/** Artifact integrity only; callers must also apply legacyPaymentProofUnavailable. */
export async function refsPassStrictPolicy(
  verification: BundleVerification,
  artifacts: ResolvedArtifact[],
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<boolean> {
  if (!verification.ok || verification.refs.some((r) => r.verdict !== "ok")) return false;
  const expected = expectedArtifacts(verification);
  if (!expected || artifacts.length !== expected.length || verification.refs.length !== expected.length) return false;
  const bundleBuyers = verification.bundle?.parties.filter((party) => party.role === "buyer") ?? [];
  const bundleSellers = verification.bundle?.parties.filter((party) => party.role === "seller") ?? [];
  if (bundleBuyers.length !== 1 || bundleSellers.length !== 1) return false;
  for (let index = 0; index < expected.length; index++) {
    const want = expected[index];
    const ref = verification.refs[index];
    const artifact = artifacts[index];
    if (ref.kind !== want.kind || ref.id !== want.id || artifact.kind !== want.kind) return false;
    if ((artifact.kind === "dacs-3-agreement" || artifact.kind === "dacs-4-evidence") &&
        artifact.raw.jobId !== verification.bundle?.jobId) return false;
    if (artifact.kind === "dacs-3-agreement" &&
        (artifact.raw.buyer !== bundleBuyers[0].primaryClaim ||
         artifact.raw.seller !== bundleSellers[0].primaryClaim)) return false;
    try {
      if (contentHash(stripSignature(artifact.raw)) !== want.contentHash) return false;
    } catch {
      return false;
    }
  }
  const partyClaims = new Set((verification.bundle?.parties ?? []).map((p) => p.primaryClaim));
  const checks = await Promise.all(
    artifacts.map((a) => verifyReferencedArtifactSignature(a, partyClaims, resolveKey)),
  );
  return checks.every(Boolean);
}

/** Resolve cancellation terms only from the exact listing pinned by a strict legacy bundle. */
export function verifiedListingTerms(
  verification: BundleVerification | null | undefined,
  artifacts: ResolvedArtifact[],
  refsVerified: boolean,
): Record<string, unknown> | undefined {
  const ref = verification?.bundle?.listingRef;
  if (!refsVerified || !ref) return undefined;
  const artifact = artifacts.find((candidate) => candidate.kind === "dacs-1-listing");
  if (!artifact) return undefined;
  const scope = stripSignature(artifact.raw) as Record<string, unknown>;
  const listingId = typeof scope.listingId === "string" ? scope.listingId
    : typeof scope.serviceId === "string" ? scope.serviceId : "";
  const rawVersion = scope.listingVersion !== undefined ? scope.listingVersion : scope.version;
  const version = rawVersion === undefined
    ? 1
    : typeof rawVersion === "number" && Number.isSafeInteger(rawVersion) && rawVersion > 0
      ? rawVersion
      : null;
  if (version === null) return undefined;
  try {
    if (listingId !== ref.listingId || version !== ref.version || contentHash(scope) !== ref.contentHash) return undefined;
  } catch {
    return undefined;
  }
  return scope.terms && typeof scope.terms === "object" && !Array.isArray(scope.terms)
    ? scope.terms as Record<string, unknown>
    : undefined;
}

export function bundleCategory(
  bundle: AttestationBundle | undefined,
  categoriesByListing: Map<string, string>,
): string | undefined {
  return bundle ? categoriesByListing.get(String(bundle.listingRef.listingId)) : undefined;
}
