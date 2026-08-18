import { contentHash, stripSignature } from "@kynesyslabs/dacs/canonical";
import {
  ARTIFACT_SEPARATORS,
  isListing,
  isVerificationMethod,
  readListingArtifact,
  verifyComponentSignature,
  type LegacyMvpListing,
  type Listing,
} from "@kynesyslabs/dacs/artifacts";
import { canonicalDemosAgentClaim } from "./claimRef.js";
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

/**
 * DACS-1 CF-2 makes only the leading `did` scheme token case-insensitive on
 * read. The current SDK validator still requires a lowercase claim scheme, so
 * validate a scheme-canonical projection while preserving and verifying the
 * exact received bytes. Method text and key casing are never rewritten.
 */
function listingValidationView(raw: Record<string, unknown>): Record<string, unknown> {
  const view = structuredClone(raw);
  const normalize = (value: unknown): unknown => typeof value === "string"
    ? canonicalDemosAgentClaim(value) ?? value
    : value;
  const seller = record(view.seller);
  const identity = record(seller?.identity);
  if (identity) {
    identity.presentedBy = normalize(identity.presentedBy);
    if (Array.isArray(identity.claims)) {
      identity.claims = identity.claims.map((claim) => {
        const item = record(claim);
        return item ? { ...item, ref: normalize(item.ref) } : claim;
      });
    }
    const presentation = record(identity.presentation);
    if (presentation && Array.isArray(presentation.signatures)) {
      presentation.signatures = presentation.signatures.map((signature) => {
        const item = record(signature);
        return item ? { ...item, ref: normalize(item.ref) } : signature;
      });
    }
  }
  const signature = record(view.signature);
  if (signature) signature.signer = normalize(signature.signer);
  return view;
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
  const bundleScope = { ...identity };
  delete bundleScope.presentation;
  const message = Buffer.from(`dacs-bundle-presentation:v1:${contentHash(bundleScope)}`, "utf8");
  return verifyEd25519(message, sellerClaim, signature.signature, resolveKey);
}

/**
 * Verify either a current normative Listing or the SDK's explicit legacy-MVP
 * read profile. Current artifacts never fall back to legacy interpretation.
 */
export async function verifyListingResult(
  raw: Record<string, unknown>,
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<ListingVerificationResult> {
  if (raw.signatures !== undefined) return invalid("LISTING_SIGNATURE_INVALID");
  if (raw.dacsVersion === "1") {
    let validationView: Record<string, unknown>;
    try {
      validationView = listingValidationView(raw);
    } catch {
      return invalid("NORMATIVE_LISTING_INVALID");
    }
    if (!isListing(validationView)) {
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
          const decoded = decodeSignature(signature.value);
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

/**
 * Fully verify discovered candidates and return the RB-2 binding this catalog
 * can publish. A bogus candidate never shadows a later valid marker.
 */
export async function findValidListingRevocation(
  candidateRefs: string[],
  listing: VerifiedListing,
  expectedVersion: number,
  readCandidate: (ref: string) => Promise<Record<string, unknown> | null>,
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<RevocationBinding | null> {
  for (const ref of candidateRefs) {
    const candidate = await readCandidate(ref);
    if (!candidate || !(await verifyListingRevocation(
      candidate, listing, expectedVersion, resolveKey,
    ))) continue;
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
  const scope = stripSignature(raw);
  if (
    scope.listingId !== (listing.scope.listingId ?? listing.scope.serviceId) ||
    scope.listingVersion !== expectedVersion ||
    typeof scope.listingContentHash !== "string" ||
    scope.listingContentHash.toLowerCase() !== listing.contentHash ||
    typeof scope.revokedAt !== "number"
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
  const message = Buffer.from(`dacs-revocation:v1:${contentHash(scope)}`, "utf8");
  const verifiedSigner = await verifyPrimaryClaimSignature(
    message, sig, listing.signer, s.algorithm, resolveKey,
  );
  const verifiedEnvelopeSigner = await resolvePrimaryClaimKey(s.signer, s.algorithm, resolveKey);
  return Boolean(
    verifiedSigner && verifiedEnvelopeSigner &&
    sameResolvedPrimaryClaim(verifiedSigner, verifiedEnvelopeSigner),
  );
}
