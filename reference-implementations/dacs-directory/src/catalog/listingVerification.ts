import { contentHash, stripSignature } from "./canonical.js";
import {
  ARTIFACT_SEPARATORS,
  isListing,
  isVerificationMethod,
  readListingArtifact,
  verifyComponentSignature,
  type IdentityBundle,
  type LegacyMvpListing,
  type Listing,
} from "@kynesyslabs/dacs/artifacts";
// This module reaches the browser bundle (VerifyDeal → bundlePolicy). The
// SDK's identity barrel also loads its domain-claim and job-ID modules, whose
// node:util/node:crypto names the browser shims do not provide, so import the
// leaf module. test/client-bundle-imports.test.ts pins this for every client
// entry.
import { identityBundleHash } from "../../vendor/dacs-sdk/dist/identity/bundle.js";
import { safePublicEndpoint } from "./publicEndpoint.js";
import {
  canonicalSigningIdentity,
  resolvePrimaryClaimKey,
  resolveDemosPrimaryClaimKey,
  sameResolvedPrimaryClaim,
  verifyPrimaryClaimSignature,
  verifyResolvedPrimaryClaimSignature,
  type ResolvedPrimaryClaimKey,
  type ResolvePrimaryClaimKey,
} from "./primaryClaimKey.js";
import {
  canonicalSignatureBytes,
  importLegacySignatureValue,
  legacySignatureBytes,
  presentationSignatureBytes,
} from "./signatureValue.js";
import type { RevocationBinding } from "./types.js";

const SEPARATOR = "dacs-listing:v1:";

interface VerifiedListingBase {
  scope: Record<string, unknown>;
  contentHash: string;
  signer: string;
  sellerClaim: string;
}

export type VerifiedListing =
  | VerifiedListingBase & { listing: Listing; profile: "dacs-v0.1" }
  | VerifiedListingBase & { listing: LegacyMvpListing; profile: "legacy-sdk-v0.1" };

export type ListingVerificationFailureCode =
  | "NORMATIVE_LISTING_INVALID"
  | "VERIFICATION_METHOD_INVALID"
  | "LISTING_SIGNATURE_INVALID"
  | "IDENTITY_PRESENTATION_INVALID"
  | "LEGACY_LISTING_INVALID";

export type ListingVerificationResult =
  | { ok: true; value: VerifiedListing }
  | { ok: false; code: ListingVerificationFailureCode };

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

// Directory catalog profile: the rules this catalog keeps on top of the pinned
// SDK reader's isListing. They only ever refuse, and run after isListing has
// accepted the artifact, so the Directory never admits a Listing an SDK reader
// refuses. Procurement remains outside this reader profile until reconciliation
// can resolve the publisher as buyer and attribute supplier history to the
// agreement seller.
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

function verificationMethodFailure(raw: Record<string, unknown>): boolean {
  const offering = record(raw.offering);
  const deliverable = record(offering?.deliverable);
  const method = deliverable?.verificationMethod;
  if (method !== undefined && !isVerificationMethod(method)) return true;
  const requiresMethod = Array.isArray(raw.pipeline) && raw.pipeline.some((step) =>
    record(step)?.kind === "deliver-attested-payload");
  return requiresMethod && (
    deliverable?.kind !== "attested-payload" || !isVerificationMethod(method)
  );
}

function invalid(
  code: ListingVerificationFailureCode,
): ListingVerificationResult {
  return { ok: false, code };
}

/**
 * DACS-1 §6.3.2 per-claim presentation by the presenting claim: the entry
 * whose `ref` is the exact `presentedBy` bytes, verified under that claim's
 * key over the same bundle-presentation bytes the SDK reader signs. The
 * Standard leaves this signature's encoding open; the pinned SDK reader
 * (sdkReaderVerifiers.ts) reads only Base64URL, but main's `/register` wrote
 * wallet hex, so both spellings are read (presentationSignatureBytes). The
 * spelling is signed Listing scope, so the Listing signature fixes it.
 */
export async function verifyIdentityPresentation(
  identity: Record<string, unknown>,
  presentedBy: string,
  resolveKey: ResolvePrimaryClaimKey,
): Promise<ResolvedPrimaryClaimKey | null> {
  const presentation = record(identity.presentation);
  if (presentation?.kind !== "per-claim" || !Array.isArray(presentation.signatures)) return null;
  const entry = presentation.signatures.map(record).find((item) => item?.ref === presentedBy);
  const sig = presentationSignatureBytes(entry?.signature);
  if (!sig) return null;
  // §6.3.2 bundle_hash omits only `presentation`; a top-level `signature`
  // member is bundle content, unlike in contentHash.
  const message = Buffer.from(
    `dacs-bundle-presentation:v1:${identityBundleHash(identity as unknown as IdentityBundle)}`,
    "utf8",
  );
  return verifyPrimaryClaimSignature(message, sig, presentedBy, "ed25519", resolveKey);
}

/**
 * Verify either a current normative Listing or the SDK's explicit legacy-MVP
 * read profile. Current artifacts never fall back to legacy interpretation.
 * Fails closed: an artifact that cannot be canonicalized or hashed (for
 * example a member with no canonical form, such as JSON 1e400) is invalid.
 */
export async function verifyListingResult(
  raw: Record<string, unknown>,
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<ListingVerificationResult> {
  try {
    return await verifyListingArtifact(raw, resolveKey);
  } catch {
    return invalid("dacsVersion" in raw ? "NORMATIVE_LISTING_INVALID" : "LEGACY_LISTING_INVALID");
  }
}

async function verifyListingArtifact(
  raw: Record<string, unknown>,
  resolveKey: ResolvePrimaryClaimKey,
): Promise<ListingVerificationResult> {
  if (raw.signatures !== undefined) return invalid("LISTING_SIGNATURE_INVALID");
  // Select the profile before validating it. A failed current artifact must
  // never acquire the looser legacy contract by adding draft SDK fields.
  if ("dacsVersion" in raw) {
    // Validate the exact received bytes, as the pinned SDK reader does at step
    // 1. CF-2 scheme-case leniency applies to standalone ClaimReference
    // lookups, never to ClaimReferences inside a signed artifact.
    if (!isListing(raw)) {
      return invalid(verificationMethodFailure(raw)
        ? "VERIFICATION_METHOD_INVALID"
        : "NORMATIVE_LISTING_INVALID");
    }
    if (!withinDirectoryProfile(raw)) return invalid("NORMATIVE_LISTING_INVALID");
    const listing = raw as unknown as Listing;
    const signatureVerdict = await verifyComponentSignature(
      raw,
      ARTIFACT_SEPARATORS.Listing,
      {
        isSignerAuthorized: (_artifact, signature) =>
          listing.seller.identity.claims.some((claim) =>
            canonicalSigningIdentity(claim.ref) === canonicalSigningIdentity(signature.signer)),
        resolvePublicKey: async (signature) => {
          const resolved = await resolvePrimaryClaimKey(
            signature.signer,
            signature.algorithm,
            resolveKey,
          );
          return resolved;
        },
        verify: ({ signedBytes, signature, publicKey }) => {
          const decoded = canonicalSignatureBytes(signature.value);
          return Boolean(
            decoded && verifyResolvedPrimaryClaimSignature(
              signedBytes,
              decoded,
              publicKey,
            ),
          );
        },
      },
    );
    if (signatureVerdict.status !== "valid") {
      return invalid("LISTING_SIGNATURE_INVALID");
    }
    const verifiedSigner = await resolvePrimaryClaimKey(
      signatureVerdict.signature.signer,
      signatureVerdict.signature.algorithm,
      resolveKey,
    );
    if (!verifiedSigner) return invalid("LISTING_SIGNATURE_INVALID");
    const identity = listing.seller.identity as unknown as Record<string, unknown>;
    const verifiedSeller = await verifyIdentityPresentation(
      identity,
      listing.seller.identity.presentedBy,
      resolveKey,
    );
    if (!verifiedSeller) return invalid("IDENTITY_PRESENTATION_INVALID");
    const scope = stripSignature(raw) as Record<string, unknown>;
    return {
      ok: true,
      value: {
        listing,
        scope,
        contentHash: contentHash(scope),
        signer: verifiedSigner.canonicalClaim,
        sellerClaim: verifiedSeller.canonicalClaim,
        profile: "dacs-v0.1",
      },
    };
  }

  if (Buffer.byteLength(JSON.stringify(raw), "utf8") > 16_384) {
    return invalid("LEGACY_LISTING_INVALID");
  }
  const readable = readListingArtifact(raw);
  if (!readable || readable.compatibility !== "legacy-mvp") {
    return invalid("LEGACY_LISTING_INVALID");
  }
  const scope = stripSignature(raw);
  const listing = readable.listing;
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
  ) return invalid("LISTING_SIGNATURE_INVALID");
  // Draft SDK listings predate SIG-6; this profile is read through the legacy decoder only.
  const sig = legacySignatureBytes(s.value);
  if (!sig) return invalid("LISTING_SIGNATURE_INVALID");
  const hash = contentHash(scope);
  const message = Buffer.from(SEPARATOR + hash, "utf8");
  const verifiedSigner = await verifyPrimaryClaimSignature(
    message, sig, s.signer, s.algorithm, resolveKey,
  );
  const verifiedAgent = await resolvePrimaryClaimKey(listing.agentId, s.algorithm, resolveKey);
  if (!verifiedSigner || !verifiedAgent || !sameResolvedPrimaryClaim(verifiedSigner, verifiedAgent)) {
    return invalid("LISTING_SIGNATURE_INVALID");
  }
  return {
    ok: true,
    value: {
      listing,
      scope,
      contentHash: hash,
      signer: verifiedSigner.canonicalClaim,
      sellerClaim: verifiedSigner.canonicalClaim,
      profile: "legacy-sdk-v0.1",
    },
  };
}

export async function verifyListing(
  raw: Record<string, unknown>,
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<VerifiedListing | null> {
  const result = await verifyListingResult(raw, resolveKey);
  return result.ok ? result.value : null;
}

/**
 * Read immutable history without weakening SIG-6 admission. Only an operator's
 * out-of-band pre-upgrade inventory can select the old Directory hex importer;
 * artifact fields, timestamps and a failed signature never grant that authority.
 * Pins bind the exact native pointer, unsigned hash, seller and listing tuple.
 * Every read still verifies the complete current schema, the Listing signature
 * and the identity presentation. The pin's declared encoding applies to the
 * Listing signature only; a hex presentation needs no pin.
 */
export async function verifyStoredListing(
  raw: Record<string, unknown>,
  nativeAddress: string,
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<VerifiedListing | null> {
  const result = await verifyStoredListingResult(raw, nativeAddress, resolveKey);
  return result.ok ? result.value : null;
}

/** verifyStoredListing with the admission code of the stored artifact when nothing imports it. */
export async function verifyStoredListingResult(
  raw: Record<string, unknown>,
  nativeAddress: string,
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<ListingVerificationResult> {
  const signature = record(raw.signature);
  if (!("dacsVersion" in raw) || canonicalSignatureBytes(signature?.value)) {
    return verifyListingResult(raw, resolveKey);
  }
  const imported = await importPinnedListing(raw, signature, nativeAddress, resolveKey);
  return imported ? { ok: true, value: imported } : verifyListingResult(raw, resolveKey);
}

async function importPinnedListing(
  raw: Record<string, unknown>,
  signature: Record<string, unknown> | null,
  nativeAddress: string,
  resolveKey: ResolvePrimaryClaimKey,
): Promise<VerifiedListing | null> {
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

/**
 * RB-2: SDK readers require the exact `presentedBy` bytes, including any
 * CF-3 advisory parameters, and the CF-4 address derived from them.
 */
export function revocationSellerClaim(listing: VerifiedListing): string {
  return listing.profile === "dacs-v0.1"
    ? listing.listing.seller.identity.presentedBy
    : listing.sellerClaim;
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
    const sellerPrimaryClaim = revocationSellerClaim(listing);
    return {
      sellerPrimaryClaim,
      listingId: String(scope.listingId),
      listingVersion: expectedVersion,
      listingContentHash: listing.contentHash,
      logicalAddress: revocationLogicalAddress(sellerPrimaryClaim, String(scope.listingId), expectedVersion),
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
  let hash: string;
  try {
    // The SDK reads only canonical JSON: a member with no canonical form
    // (e.g. JSON 1e400) can be neither stripped nor signed.
    scope = stripSignature(raw);
    hash = contentHash(scope);
  } catch {
    return false;
  }
  if (
    scope.listingId !== (listing.scope.listingId ?? listing.scope.serviceId) ||
    scope.listingVersion !== expectedVersion ||
    typeof scope.listingContentHash !== "string" ||
    scope.listingContentHash.toLowerCase() !== listing.contentHash ||
    // The SDK's RB-1 isRevocationMarker reads revokedAt as a non-negative safe integer.
    !Number.isSafeInteger(scope.revokedAt) ||
    Number(scope.revokedAt) < 0
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
