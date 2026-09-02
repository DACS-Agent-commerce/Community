// These functions are public from the SDK root, but importing that barrel into
// Next also evaluates optional rail/CLI dependencies (including re2.wasm).
// Use the exact pinned implementation modules until the SDK ships a pure agent
// verification export condition.
import {
  isVerifiedListingAdmission,
  validateListingArtifact,
  type ListingRailAuthorityInput,
} from "../../vendor/dacs-sdk/dist/agent/listingValidation.js";
import { contentHash, stripSignature } from "@kynesyslabs/dacs/canonical";
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import {
  isLegacyMvpListing,
  type ComponentSignature,
  type IdentityBundle,
  type LegacyMvpListing,
  type Listing,
  type RevocationBinding,
} from "@kynesyslabs/dacs/artifacts";
import {
  parseCanonicalClaimReference,
  sameCanonicalClaimIdentity,
} from "@kynesyslabs/dacs/identity";

const LEGACY_SEPARATOR = "dacs-listing:v1:";

function decodeSignature(value: string, allowHex = false): Uint8Array | null {
  const hex = value.replace(/^(0x)+/i, "");
  if (allowHex && /^[0-9a-fA-F]{128}$/.test(hex)) {
    return Uint8Array.from(Buffer.from(hex, "hex"));
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === 64 && decoded.toString("base64url") === value
      ? Uint8Array.from(decoded)
      : null;
  } catch {
    return null;
  }
}

/** Resolve only explicit self-certifying Demos/key claims; never suffix aliases. */
export function publicKeyForClaim(claim: string): Uint8Array | null {
  const parsed = parseCanonicalClaimReference(claim);
  if (!parsed) return null;
  const identifier = parsed.identity.identifier;
  const hex = parsed.identity.scheme === "did"
    ? /^demos:agent:([0-9a-f]{64})$/.exec(identifier)?.[1]
    : parsed.identity.scheme === "key"
      ? /^([0-9a-f]{64})$/.exec(identifier)?.[1]
      : undefined;
  return hex ? Uint8Array.from(Buffer.from(hex, "hex")) : null;
}

async function verifyComponentSignature(input: {
  signedBytes: Uint8Array;
  signature: Readonly<ComponentSignature>;
}): Promise<boolean> {
  if (input.signature.algorithm !== "ed25519") return false;
  const key = publicKeyForClaim(input.signature.signer);
  const signature = decodeSignature(input.signature.value);
  if (!key || !signature) return false;
  try {
    return await ed25519Verify(input.signedBytes, signature, publicKeyFromRaw(key));
  } catch {
    return false;
  }
}

async function verifyIdentityPresentation(input: {
  bundle: Readonly<IdentityBundle>;
  signedBytes: Uint8Array;
}): Promise<boolean> {
  const presentation = input.bundle.presentation;
  if (presentation.kind === "per-claim") {
    const proof = presentation.signatures.find((entry) =>
      sameCanonicalClaimIdentity(entry.ref, input.bundle.presentedBy));
    if (!proof) return false;
    const key = publicKeyForClaim(proof.ref);
    const signature = decodeSignature(proof.signature);
    return !!key && !!signature && ed25519Verify(
      input.signedBytes,
      signature,
      publicKeyFromRaw(key),
    );
  }
  if (presentation.kind === "sr1-root") {
    if (!sameCanonicalClaimIdentity(presentation.rootClaim, input.bundle.presentedBy)) return false;
    const key = publicKeyForClaim(presentation.rootClaim);
    const signature = decodeSignature(presentation.aggregateSignature);
    return !!key && !!signature && ed25519Verify(
      input.signedBytes,
      signature,
      publicKeyFromRaw(key),
    );
  }
  // SIWD and delegated session keys require scheme/root authorities this
  // Demos-only deployment does not possess. Unsupported presentations fail closed.
  return false;
}

/**
 * PA-1 is application authority, never listing-supplied authority. Keep this
 * deliberately small: adding a rail here is a security/configuration change.
 */
export const DIRECTORY_RAIL_DEFINITIONS = Object.freeze([
  {
    railId: "dem:default",
    railVersion: 1,
    phaseHandler: "pay-dem",
    governanceAnchoring: "in-code",
    signatureValid: true,
  },
  {
    railId: "x402:default",
    railVersion: 1,
    phaseHandler: "pay-x402",
    governanceAnchoring: "in-code",
    signatureValid: true,
  },
] as const);

function inCodeRailAuthority(_listing: Readonly<Listing>): ListingRailAuthorityInput {
  return {
    trustPhase: "PA-1",
    trustPolicyAcceptsPA1: true,
    registry: { state: "not-used", entries: [], definitions: [] },
    inCodeDefinitions: DIRECTORY_RAIL_DEFINITIONS.map((definition) => ({ ...definition })),
  };
}

/** Exact-byte payload verification supported by this directory deployment. */
function payloadVerificationCapability(input: {
  verificationMethod: Readonly<{ kind: string }>;
}) {
  return input.verificationMethod.kind === "self-signed"
    ? { disposition: "supported" as const, reason: "configured-self-signed-ed25519" }
    : { disposition: "unsupported" as const, reason: "method-not-configured" };
}

export interface VerifyListingOptions {
  nowMs?: number;
  revocations?: RevocationBinding[];
  readMarker?: (anchor: RevocationBinding["markerAnchor"]) => Promise<Record<string, unknown> | null>;
}

export type VerifiedListing =
  | {
      profile: "current";
      listing: Listing;
      scope: Record<string, unknown>;
      contentHash: string;
      signer: string;
      revocation?: RevocationBinding;
    }
  | {
      profile: "legacy-mvp";
      listing: LegacyMvpListing;
      scope: Record<string, unknown>;
      contentHash: string;
      signer: string;
    };

async function verifyCurrentListing(
  raw: Record<string, unknown>,
  options: VerifyListingOptions,
): Promise<VerifiedListing | null> {
  const now = options.nowMs ?? Date.now();
  const revocations = options.revocations ?? [];
  const run = (binding?: RevocationBinding) => validateListingArtifact(raw, {
    nowMs: () => now,
    verifyListingSignature: verifyComponentSignature,
    revocation: {
      surfaces: binding
        ? [{
            kind: "catalog" as const,
            status: "revoked" as const,
            catalogObservedAt: now,
            binding,
          }]
        : [{
            kind: "catalog" as const,
            status: "active" as const,
            catalogObservedAt: now,
          }],
      readMarker: options.readMarker ?? (async () => null),
      verifyMarkerSignature: verifyComponentSignature,
    },
    verifyIdentityPresentation,
    loadRailResolution: inCodeRailAuthority,
    resolvePayloadVerificationCapability: payloadVerificationCapability,
    verifySellerControl: ({ bundle, signer }) =>
      sameCanonicalClaimIdentity(bundle.presentedBy, signer) && publicKeyForClaim(signer) !== null,
  }).catch(() => null);
  for (const binding of revocations) {
    const revoked = await run(binding);
    if (
      revoked?.disposition === "revoked" &&
      revoked.listing &&
      revoked.listingContentHash
    ) {
      return {
        profile: "current",
        listing: revoked.listing,
        scope: raw,
        contentHash: revoked.listingContentHash,
        signer: revoked.listing.signature.signer,
        revocation: binding,
      };
    }
  }
  const result = await run();
  if (!result || !isVerifiedListingAdmission(raw, result)) return null;
  return {
    profile: "current",
    listing: result.listing,
    scope: raw,
    contentHash: result.listingContentHash,
    signer: result.listing.signature.signer,
  };
}

async function verifyLegacyListing(raw: Record<string, unknown>): Promise<VerifiedListing | null> {
  const scope = stripSignature(raw);
  if (!isLegacyMvpListing(scope)) return null;
  const listing = scope;
  const signature = raw.signature;
  const envelope: Record<string, unknown> = typeof signature === "string"
    ? { algorithm: "ed25519", signer: listing.agentId, value: signature }
    : signature && typeof signature === "object" && !Array.isArray(signature)
      ? signature as Record<string, unknown>
      : {};
  if (
    envelope.algorithm !== "ed25519" ||
    envelope.signer !== listing.agentId ||
    typeof envelope.value !== "string"
  ) return null;
  const key = publicKeyForClaim(listing.agentId);
  const signatureBytes = decodeSignature(envelope.value, true);
  if (!key || !signatureBytes) return null;
  const hash = contentHash(scope);
  let valid = false;
  try {
    valid = await ed25519Verify(
      Buffer.from(LEGACY_SEPARATOR + hash, "utf8"),
      signatureBytes,
      publicKeyFromRaw(key),
    );
  } catch {
    valid = false;
  }
  return valid
    ? {
        profile: "legacy-mvp",
        listing,
        scope,
        contentHash: hash,
        signer: listing.agentId,
      }
    : null;
}

/** Authenticate a current Listing, with an isolated read-only MVP fallback. */
export async function verifyListing(
  raw: Record<string, unknown>,
  options: VerifyListingOptions = {},
): Promise<VerifiedListing | null> {
  return (await verifyCurrentListing(raw, options)) ?? verifyLegacyListing(raw);
}

export function ownerClaim(owner: string | undefined): string | null {
  const hex = owner?.match(/^(?:0x)?([0-9a-fA-F]{64})$/)?.[1];
  return hex ? `did:demos:agent:${hex.toLowerCase()}` : null;
}

/** Historical MVP marker verifier; current markers go through SDK validation. */
export async function verifyListingRevocation(
  raw: Record<string, unknown>,
  listing: VerifiedListing,
  expectedVersion: number,
): Promise<boolean> {
  if (listing.profile !== "legacy-mvp") return false;
  const scope = stripSignature(raw);
  if (
    scope.listingId !== (listing.scope.listingId ?? listing.listing.serviceId) ||
    scope.listingVersion !== expectedVersion ||
    typeof scope.listingContentHash !== "string" ||
    scope.listingContentHash.toLowerCase() !== listing.contentHash ||
    typeof scope.revokedAt !== "number"
  ) return false;
  const signature = raw.signature;
  if (!signature || typeof signature !== "object" || Array.isArray(signature)) return false;
  const entry = signature as Record<string, unknown>;
  if (entry.algorithm !== "ed25519" || entry.signer !== listing.signer || typeof entry.value !== "string") {
    return false;
  }
  const key = publicKeyForClaim(listing.signer);
  const bytes = decodeSignature(entry.value, true);
  if (!key || !bytes) return false;
  try {
    return await ed25519Verify(
      Buffer.from(`dacs-revocation:v1:${contentHash(scope)}`, "utf8"),
      bytes,
      publicKeyFromRaw(key),
    );
  } catch {
    return false;
  }
}

export async function hasValidListingRevocation(
  candidateRefs: string[],
  listing: VerifiedListing,
  expectedVersion: number,
  readCandidate: (ref: string) => Promise<Record<string, unknown> | null>,
): Promise<boolean> {
  for (const ref of candidateRefs) {
    const candidate = await readCandidate(ref);
    if (candidate && await verifyListingRevocation(candidate, listing, expectedVersion)) return true;
  }
  return false;
}
