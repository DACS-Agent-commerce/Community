import { contentHash, stripSignature } from "@kynesyslabs/dacs/canonical";
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import type { AttestationBundle } from "@kynesyslabs/dacs/artifacts";
import type { BundleVerification } from "../../vendor/dacs-sdk/dist/agent/verifyBundleCore.js";

import { bundleSignerPolicy, demosSigningIdentity } from "./bundleSignerPolicy.js";
import { verifyListing } from "./listingVerification.js";
import type { DealRecord, RegisteredDeal } from "./types.js";

// PAYEE-BOUND COUPLING (issue #17 F2): site (c) of 3 (mirror of evidenceGraph.ts SEPARATORS).
// No `dacs-payee-bound-agreement:v1:` domain yet. When payee-bound support lands, add it here
// AND in evidenceGraph.ts, alongside shapeOk's discriminator and isNeutralCancellation's
// commit-kind. §8.5.1: SELECT the domain from the required discriminator — never strip-and-retry.
const SEPARATORS: Record<string, string> = {
  "dacs-3-agreement": "dacs-agreement:v1:",
  "dacs-4-evidence": "dacs-evidence:v1:",
  "dacs-2-verifyresult": "dacs-composite:v1:",
};

function decode(value: string): Uint8Array | null {
  const hex = value.replace(/^(0x)+/i, "");
  if (/^[0-9a-fA-F]{128}$/.test(hex)) return Uint8Array.from(Buffer.from(hex, "hex"));
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.length === 64 ? Uint8Array.from(bytes) : null;
  } catch {
    return null;
  }
}

function keyFor(claim: string): ReturnType<typeof publicKeyFromRaw> | null {
  const hex = claim.match(/([0-9a-fA-F]{64})$/)?.[1];
  if (!hex) return null;
  try {
    return publicKeyFromRaw(Uint8Array.from(Buffer.from(hex, "hex")));
  } catch {
    return null;
  }
}

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
    result.signatures.every((signature) => signature.verdict === "valid"));
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

/** Keep at most one verified reputation record per signed job and bundle ref. */
export function dedupeVerifiedDeals(deals: DealRecord[]): DealRecord[] {
  const jobs = new Set<string>();
  const refs = new Set<string>();
  return deals.filter((deal) => {
    if (!deal.refsVerified) return true;
    const ref = deal.buyerBundleRef.toLowerCase();
    if (jobs.has(deal.jobId) || refs.has(ref)) return false;
    jobs.add(deal.jobId);
    refs.add(ref);
    return true;
  });
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
): Promise<boolean> {
  if (artifact.kind === "dacs-1-listing") return (await verifyListing(artifact.raw)) !== null;
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
    const key = keyFor(signer);
    const signature = decode(s.value);
    if (!key || !signature || !(await ed25519Verify(message, signature, key))) return false;
    validSigners.add(signer);
  }
  if (artifact.kind === "dacs-3-agreement") {
    const buyer = scope.buyer;
    const seller = scope.seller;
    return typeof buyer === "string" && typeof seller === "string" &&
      validSigners.has(buyer) && validSigners.has(seller);
  }
  if (artifact.kind === "dacs-4-evidence") {
    return [...validSigners].some((s) => partyClaims.has(s));
  }
  return true;
}

export async function refsPassStrictPolicy(
  verification: BundleVerification,
  artifacts: ResolvedArtifact[],
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
    artifacts.map((a) => verifyReferencedArtifactSignature(a, partyClaims)),
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
