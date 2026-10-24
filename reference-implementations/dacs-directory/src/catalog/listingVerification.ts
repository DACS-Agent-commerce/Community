import { legacyListingHash } from "./legacyListingHash.js";
import { canonicalize, contentHash, stripSignature } from "./canonical.js";
import { isListing as isCurrentListing, isLegacyMvpListing as isListing, type LegacyMvpListing as Listing } from "@kynesyslabs/dacs/artifacts";
import { safePublicEndpoint } from "./publicEndpoint.js";
import {
  canonicalSigningIdentity,
  resolvePrimaryClaimKey,
  resolveDemosPrimaryClaimKey,
  sameResolvedPrimaryClaim,
  verifyPrimaryClaimSignature,
  type ResolvedPrimaryClaimKey,
  type ResolvePrimaryClaimKey,
} from "./primaryClaimKey.js";
import { canonicalSignatureBytes, importLegacySignatureValue, legacySignatureBytes } from "./signatureValue.js";
import type { RevocationBinding } from "./types.js";

const SEPARATOR = "dacs-listing:v1:";
/** DACS-1 LR-2: the canonical form (signature omitted) of a listing is at most 16 KB. */
export const MAX_LISTING_CANONICAL_BYTES = 16_384;

export interface VerifiedListing {
  listing: Listing | Record<string, unknown>;
  scope: Record<string, unknown>;
  contentHash: string;
  signer: string;
  sellerClaim: string;
  profile: "dacs-v0.1" | "legacy-sdk-v0.1";
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
// Procurement remains outside this reader profile until reconciliation can resolve
// the publisher as buyer and attribute supplier history to the agreement seller.
const PHASES = new Set([
  "vet-credentials", "negotiate-fixed-price", "negotiate-rfq", "negotiate-sealed-envelope",
  "commit-agreement", "commit-payee-bound-agreement",
  "pay-evm-erc20", "pay-solana-spl", "pay-cross-chain-htlc", "pay-cross-chain-liquidity-tank", "pay-ap2", "pay-x402", "pay-dem",
  "deliver-storage-program", "deliver-entitlement", "deliver-attested-payload", "rate",
]);
/** DACS-4 PricingSpec auction `selectionRule`: a closed enum plus content-hash-bound rule refs. */
const SELECTION_RULES = new Set(["lowest-price", "highest-price", "first-acceptable"]);
const validSelectionRule = (value: unknown): boolean =>
  typeof value === "string" && (SELECTION_RULES.has(value) || /^rule-ref:[0-9a-f]{64}:\S+$/.test(value));

// NOTE (open-world listing shape): the directory does NOT reject a listing that carries
// unknown top-level fields. §11.1.2 (additivity) lets a later minor add top-level listing
// fields, and the older-reads-newer contract (CORE.md) requires an older reader to consume a
// newer-minor artifact correctly; SIG-5 (preserve-unknown) is the mechanism that makes that
// safe — a verifier MAY ignore the *meaning* of unknown fields but MUST preserve them (it must
// not strip them from the signed content). This validator only reads the recognised fields
// below, so unknown fields are neither indexed nor interpreted, and verifyListing() hashes the
// whole scope (contentHash) so they remain signature-bound — a field injected after signing
// still fails the hash. A closed top-level
// allowlist here would reject every listing produced under the first minor that adds a
// top-level field, breaking forward compatibility.

function validPriceTerm(value: unknown): boolean {
  const term = record(value);
  return Boolean(term && typeof term.amount === "string" && /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(term.amount) &&
    Number.isFinite(Number(term.amount)) && Number(term.amount) > 0 && typeof term.currency === "string" && term.currency.length > 0 && term.currency.length <= 64 &&
    (term.unit === undefined || (typeof term.unit === "string" && term.unit.length > 0 && term.unit.length <= 64)));
}

function withinDirectoryProfile(listing: Record<string, unknown>): boolean {
  const seller = record(listing.seller);
  const offering = record(listing.offering);
  const pricing = record(listing.pricing);
  const terms = record(listing.terms);
  const pipeline = Array.isArray(listing.pipeline) ? listing.pipeline.map(record) : [];
  const pricingOk = pricing?.kind === "fixed" ? validPriceTerm(pricing.price)
    : pricing?.kind === "negotiable" ? validPriceTerm(pricing.bandCenter)
      : pricing?.kind === "auction" ? (!pricing.reservePrice || validPriceTerm(pricing.reservePrice)) && validSelectionRule(pricing.selectionRule)
        : pricing?.kind === "metered" ? validPriceTerm(pricing.unitPrice) &&
          typeof pricing.unit === "string" && pricing.unit.length > 0 && pricing.unit.length <= 64 &&
          (pricing.minTotal === undefined || validPriceTerm(pricing.minTotal)) : false;
  const negotiationIndex = pipeline.findIndex((step) => typeof step?.kind === "string" && step.kind.startsWith("negotiate-"));
  const conflictOfLawsRule = terms?.conflictOfLawsRule;
  return pricingOk && pipeline.every((step) => typeof step?.kind === "string" && PHASES.has(step.kind)) &&
    // VPC-1/2: vet authorization precedes negotiation.
    pipeline.every((step, index) => step?.kind !== "vet-credentials" || index < negotiationIndex) &&
    // A sealed-envelope step's selectionRule is authoritative and the auction PricingSpec's must equal it.
    pipeline.every((step) => step?.kind !== "negotiate-sealed-envelope" ||
      (validSelectionRule(record(step.parameters)?.selectionRule) && record(step.parameters)?.selectionRule === pricing?.selectionRule)) &&
    typeof offering?.category === "string" && /^[a-z0-9.-]{1,64}$/.test(offering.category) &&
    (seller?.publicEndpoint === undefined || safePublicEndpoint(seller.publicEndpoint) !== undefined) &&
    (typeof conflictOfLawsRule !== "string" || !conflictOfLawsRule.startsWith("rule-ref:") || /^rule-ref:\S+$/.test(conflictOfLawsRule));
}
function currentListing(scope: Record<string, unknown>): {
  signer: string; sellerClaim: string; signature: Record<string, unknown>;
} | null {
  if (!isCurrentListing(scope) || !withinDirectoryProfile(scope)) return null;
  return { signer: scope.signature.signer, sellerClaim: scope.seller.identity.presentedBy,
    signature: scope.signature as unknown as Record<string, unknown> };
}

async function verifyEd25519(
  message: Uint8Array,
  signer: string,
  sig: Uint8Array | null,
  resolveKey: ResolvePrimaryClaimKey,
): Promise<ResolvedPrimaryClaimKey | null> {
  return sig
    ? verifyPrimaryClaimSignature(message, sig, signer, "ed25519", resolveKey)
    : null;
}

export async function verifyIdentityPresentation(
  identity: Record<string, unknown>,
  sellerClaim: string,
  resolveKey: ResolvePrimaryClaimKey,
): Promise<ResolvedPrimaryClaimKey | null> {
  const presentation = record(identity.presentation);
  if (presentation?.kind !== "per-claim" || !Array.isArray(presentation.signatures)) return null;
  const sellerIdentity = canonicalSigningIdentity(sellerClaim);
  const signature = presentation.signatures.map(record).find((item) =>
    typeof item?.ref === "string" && canonicalSigningIdentity(item.ref) === sellerIdentity);
  if (!signature) return null;
  const bundleScope = { ...identity };
  delete bundleScope.presentation;
  const message = Buffer.from(`dacs-bundle-presentation:v1:${contentHash(bundleScope)}`, "utf8");
  // A per-claim PresentationSignature carries a bare `signature` string, not a
  // SIG-6 envelope `value`; the Directory's publisher writes the wallet's hex.
  const value = typeof signature.signature === "string" ? legacySignatureBytes(signature.signature) : null;
  return verifyEd25519(message, sellerClaim, value, resolveKey);
}

/** Verify either the current normative Listing or the pinned SDK compatibility profile. */
export async function verifyListing(
  raw: Record<string, unknown>,
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<VerifiedListing | null> {
  if (raw.signatures !== undefined) return null;
  // Select the profile before validating it. A failed current artifact must
  // never acquire the looser legacy contract by adding draft SDK fields.
  if ("dacsVersion" in raw) {
    const current = currentListing(raw);
    if (!current) return null;
    const scope = { ...raw };
    delete scope.signature;
    if (Buffer.byteLength(canonicalize(scope), "utf8") > MAX_LISTING_CANONICAL_BYTES) return null;
    if (current.signature.algorithm !== "ed25519") return null;
    const hash = contentHash(scope);
    const verifiedSigner = await verifyEd25519(
      Buffer.from(SEPARATOR + hash, "utf8"), current.signer, canonicalSignatureBytes(current.signature.value), resolveKey,
    );
    const seller = record(raw.seller);
    const identity = record(seller?.identity);
    const verifiedSeller = identity
      ? await verifyIdentityPresentation(identity, current.sellerClaim, resolveKey)
      : null;
    if (!verifiedSigner || !verifiedSeller) return null;
    return {
      listing: raw,
      scope,
      contentHash: hash,
      signer: verifiedSigner.canonicalClaim,
      sellerClaim: verifiedSeller.canonicalClaim,
      profile: "dacs-v0.1",
    };
  }

  const scope = stripSignature(raw);
  if (!isListing(scope)) return null;
  const listing = scope as unknown as Listing;
  const signature = raw.signature;
  // Early SDK listings stored only the Ed25519 value. Their signer is still
  // unambiguous because agentId is inside the signed scope and is also checked
  // against the substrate owner by the indexer.
  const s: Record<string, unknown> = typeof signature === "string"
    ? { algorithm: "ed25519", signer: listing.agentId, value: signature }
    : signature && typeof signature === "object" && !Array.isArray(signature)
      ? signature as Record<string, unknown>
      : {};
  if (
    s.algorithm !== "ed25519" ||
    typeof s.signer !== "string" ||
    typeof s.value !== "string"
  ) return null;
  // Draft SDK listings predate SIG-6; this profile is read through the legacy decoder only.
  const sig = legacySignatureBytes(s.value);
  if (!sig) return null;
  const hash = legacyListingHash(scope);
  const message = Buffer.from(SEPARATOR + hash, "utf8");
  const verifiedSigner = await verifyPrimaryClaimSignature(
    message, sig, s.signer, s.algorithm, resolveKey,
  );
  const verifiedAgent = await resolvePrimaryClaimKey(listing.agentId, s.algorithm, resolveKey);
  if (!verifiedSigner || !verifiedAgent || !sameResolvedPrimaryClaim(verifiedSigner, verifiedAgent)) return null;
  return {
    listing,
    scope,
    contentHash: hash,
    signer: verifiedSigner.canonicalClaim,
    sellerClaim: verifiedSigner.canonicalClaim,
    profile: "legacy-sdk-v0.1",
  };
}

/**
 * Read immutable history without weakening SIG-6 admission. Only an operator's
 * out-of-band pre-upgrade inventory can select the old Directory hex importer;
 * artifact fields, timestamps and a failed signature never grant that authority.
 * Pins bind the exact native pointer, unsigned hash, seller and listing tuple.
 * Every read still verifies the complete current schema and both signatures.
 */
export async function verifyStoredListing(
  raw: Record<string, unknown>,
  nativeAddress: string,
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<VerifiedListing | null> {
  const signature = record(raw.signature);
  if (!("dacsVersion" in raw) || canonicalSignatureBytes(signature?.value)) {
    return verifyListing(raw, resolveKey);
  }
  if (!/^stor-[0-9a-f]{40}$/.test(nativeAddress)) return null;
  const configured = process.env.DACS_HISTORICAL_LISTING_IMPORTS;
  if (!configured || Buffer.byteLength(configured, "utf8") > 65_536) return null;
  try {
    const pins = record(JSON.parse(configured));
    if (!pins || Object.keys(pins).length > 256 || !Object.hasOwn(pins, nativeAddress)) return null;
    const pin = record(pins[nativeAddress]);
    if (!pin || pin.encoding !== "lowercase-hex" || typeof pin.contentHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(pin.contentHash) || typeof pin.sellerPrimaryClaim !== "string" ||
        pin.listingId !== raw.listingId || pin.listingVersion !== raw.listingVersion) return null;
    const value = typeof signature?.value === "string"
      ? importLegacySignatureValue(signature.value, "lowercase-hex") : null;
    if (!value) return null;
    // Only the unsigned envelope changes in memory. Keep the native bytes,
    // signed scope and pinned hash intact; never re-sign or write a replacement.
    const verified = await verifyListing({ ...raw, signature: { ...signature, value } }, resolveKey);
    return verified && verified.contentHash === pin.contentHash &&
      verified.sellerClaim === pin.sellerPrimaryClaim && verified.signer === pin.sellerPrimaryClaim
      ? verified : null;
  } catch {
    return null;
  }
}

/** A bogus candidate must never shadow another valid owner-signed marker. */
export async function hasValidListingRevocation(
  candidateRefs: string[],
  listing: VerifiedListing,
  expectedVersion: number,
  readCandidate: (ref: string) => Promise<Record<string, unknown> | null>,
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<boolean> {
  return Boolean(await findValidListingRevocation(
    candidateRefs,
    listing,
    expectedVersion,
    readCandidate,
    resolveKey,
  ));
}

/** Encode the delimiter-bearing ClaimReference segment required by CF-4. */
export function revocationLogicalAddress(
  sellerPrimaryClaim: string,
  listingId: string,
  listingVersion: number,
): string {
  const encodedClaim = sellerPrimaryClaim.replace(
    /[:?&=%]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `dacs1-revoked:${encodedClaim}:${listingId}:v${listingVersion}`;
}

/** Per-listing, per-pass candidate bound; each may check cached and current bytes. */
export const REVOCATION_VERIFICATIONS_PER_PASS = 16;

/** Candidates examined by one call: unreadable ones are retried later, rejected ones were read and failed RB-4. */
export interface RevocationCandidateProgress {
  unread: string[];
  rejected: string[];
}

/**
 * Fully verify discovered candidates, in the given order and at most `limit`
 * of them, and return the RB-2 binding this catalog can publish. A bogus
 * candidate never shadows a later valid marker; unexamined candidates are
 * left for a later call. When the first reader supplies cached observations,
 * a failed check must use the current reader before recording a rejection.
 * This bounds work to `limit` current reads and at most `2 * limit` checks.
 */
export async function findValidListingRevocation(
  candidateRefs: string[],
  listing: VerifiedListing,
  expectedVersion: number,
  readCandidate: (ref: string) => Promise<Record<string, unknown> | null>,
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
  progress: RevocationCandidateProgress = { unread: [], rejected: [] },
  limit = REVOCATION_VERIFICATIONS_PER_PASS,
  readCurrentCandidate?: (ref: string) => Promise<Record<string, unknown> | null>,
): Promise<RevocationBinding | null> {
  for (const ref of [...new Set(candidateRefs)].slice(0, limit)) {
    let candidate = await readCandidate(ref);
    let valid = candidate ? await verifyListingRevocation(candidate, listing, expectedVersion, resolveKey) : false;
    if (!valid && readCurrentCandidate) {
      candidate = await readCurrentCandidate(ref);
      valid = candidate ? await verifyListingRevocation(candidate, listing, expectedVersion, resolveKey) : false;
    }
    if (!candidate) {
      progress.unread.push(ref);
      continue;
    }
    if (!valid) {
      progress.rejected.push(ref);
      continue;
    }
    const scope = stripSignature(candidate);
    return {
      sellerPrimaryClaim: listing.sellerClaim,
      listingId: String(scope.listingId),
      listingVersion: expectedVersion,
      listingContentHash: listing.contentHash,
      logicalAddress: revocationLogicalAddress(listing.sellerClaim, String(scope.listingId), expectedVersion),
      markerAnchor: { kind: "storage-program", locator: ref },
      markerContentHash: contentHash(scope),
    };
  }
  return null;
}

export function ownerClaim(owner: string | undefined): string | null {
  const hex = owner?.match(/([0-9a-fA-F]{64})$/)?.[1];
  return hex ? `did:demos:agent:${hex.toLowerCase()}` : null;
}

export async function verifyListingRevocation(
  raw: Record<string, unknown>,
  listing: VerifiedListing,
  expectedVersion: number,
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<boolean> {
  let scope: Record<string, unknown>;
  try { scope = stripSignature(raw); } catch { return false; }
  if (
    scope.listingId !== (listing.scope.listingId ?? (listing.listing as Listing).serviceId) ||
    scope.listingVersion !== expectedVersion ||
    typeof scope.listingContentHash !== "string" ||
    scope.listingContentHash.toLowerCase() !== listing.contentHash ||
    // Preserve the historical reader's integer domain until the strict RB-1 reader activates.
    !Number.isSafeInteger(scope.revokedAt)
  ) return false;
  const signature = raw.signature;
  if (!signature || typeof signature !== "object" || Array.isArray(signature)) return false;
  const s = signature as Record<string, unknown>;
  if (
    s.algorithm !== "ed25519" || typeof s.signer !== "string" ||
    typeof s.value !== "string"
  ) return false;
  // A marker is a current-profile artifact whatever the listing's profile: SIG-6 applies.
  const sig = canonicalSignatureBytes(s.value);
  if (!sig) return false;
  let hash: string;
  try {
    hash = contentHash(scope);
  } catch {
    // An unknown member with no canonical form (e.g. JSON 1e400) cannot be signed.
    return false;
  }
  const message = Buffer.from(`dacs-revocation:v1:${hash}`, "utf8");
  const verifiedSigner = await verifyPrimaryClaimSignature(
    message, sig, listing.signer, s.algorithm, resolveKey,
  );
  const verifiedEnvelopeSigner = await resolvePrimaryClaimKey(s.signer, s.algorithm, resolveKey);
  return Boolean(
    verifiedSigner && verifiedEnvelopeSigner &&
    sameResolvedPrimaryClaim(verifiedSigner, verifiedEnvelopeSigner),
  );
}
