import { contentHash, stripSignature } from "@kynesyslabs/dacs/canonical";
import {
  ARTIFACT_SEPARATORS,
  isCanonicalBase64Url,
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
import type { RevocationBinding } from "./types.js";

const SEPARATOR = "dacs-listing:v1:";

/**
 * Legacy-MVP raw hex or base64url. Used for legacy Listings, identity
 * presentations (whose encoding the SDK leaves to the presentation verifier)
 * and revocation markers, where accepting either encoding can only withdraw a
 * Listing. Never used for a current Listing's own signature.
 */
function decodeSignature(value: string): Uint8Array | null {
  const hex = value.replace(/^(0x)+/i, "");
  if (/^[0-9a-fA-F]{128}$/.test(hex)) return Uint8Array.from(Buffer.from(hex, "hex"));
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === 64 ? Uint8Array.from(decoded) : null;
  } catch {
    return null;
  }
}

/**
 * CORE §B.7 SIG-6: a current ComponentSignature value is canonical unpadded
 * base64url, and Ed25519 values decode to exactly 64 bytes. Raw hex is the
 * legacy-MVP representation; 128 hex characters are valid base64url text but
 * decode to 96 bytes, so SDK readers reject them.
 */
function decodeComponentSignature(value: string): Uint8Array | null {
  if (!isCanonicalBase64Url(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 64 ? Uint8Array.from(decoded) : null;
}

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

async function verifyEd25519(
  message: Uint8Array,
  signer: string,
  value: unknown,
  resolveKey: ResolvePrimaryClaimKey,
): Promise<ResolvedPrimaryClaimKey | null> {
  const sig = typeof value === "string" ? decodeSignature(value) : null;
  return sig
    ? verifyPrimaryClaimSignature(message, sig, signer, "ed25519", resolveKey)
    : null;
}

async function verifyIdentityPresentation(
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
  // §6.3.2 bundle_hash omits only `presentation`; a top-level `signature`
  // member is bundle content, unlike in contentHash.
  const message = Buffer.from(
    `dacs-bundle-presentation:v1:${identityBundleHash(identity as unknown as IdentityBundle)}`,
    "utf8",
  );
  return verifyEd25519(message, sellerClaim, signature.signature, resolveKey);
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
    return invalid(raw.dacsVersion === "1" ? "NORMATIVE_LISTING_INVALID" : "LEGACY_LISTING_INVALID");
  }
}

async function verifyListingArtifact(
  raw: Record<string, unknown>,
  resolveKey: ResolvePrimaryClaimKey,
): Promise<ListingVerificationResult> {
  if (raw.signatures !== undefined) return invalid("LISTING_SIGNATURE_INVALID");
  if (raw.dacsVersion === "1") {
    // Validate the exact received bytes, as the pinned SDK reader does at step
    // 1. CF-2 scheme-case leniency applies to standalone ClaimReference
    // lookups, never to ClaimReferences inside a signed artifact.
    if (!isListing(raw)) {
      return invalid(verificationMethodFailure(raw)
        ? "VERIFICATION_METHOD_INVALID"
        : "NORMATIVE_LISTING_INVALID");
    }
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
          const decoded = decodeComponentSignature(signature.value);
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
  const sig = decodeSignature(s.value);
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

/** Per-listing, per-pass bound on candidate reads and RB-4 verifications. */
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
 * left for a later call.
 */
export async function findValidListingRevocation(
  candidateRefs: string[],
  listing: VerifiedListing,
  expectedVersion: number,
  readCandidate: (ref: string) => Promise<Record<string, unknown> | null>,
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
  progress: RevocationCandidateProgress = { unread: [], rejected: [] },
  limit = REVOCATION_VERIFICATIONS_PER_PASS,
): Promise<RevocationBinding | null> {
  for (const ref of [...new Set(candidateRefs)].slice(0, limit)) {
    const candidate = await readCandidate(ref);
    if (!candidate) {
      progress.unread.push(ref);
      continue;
    }
    if (!(await verifyListingRevocation(candidate, listing, expectedVersion, resolveKey))) {
      progress.rejected.push(ref);
      continue;
    }
    const scope = stripSignature(candidate);
    // RB-2: SDK readers require the exact `presentedBy` bytes, including any
    // CF-3 advisory parameters, and the CF-4 address derived from them.
    const sellerPrimaryClaim = listing.profile === "dacs-v0.1"
      ? listing.listing.seller.identity.presentedBy
      : listing.sellerClaim;
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
  const sig = decodeSignature(s.value);
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
