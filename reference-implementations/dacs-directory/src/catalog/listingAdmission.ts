/** Stable, public-safe listing admission diagnostics. */
export const LISTING_REJECTION_CODES = [
  "SELLER_CLAIM_BINDING",
  "OWNER_CLAIM_BINDING",
  "NORMATIVE_LISTING_INVALID",
  "VERIFICATION_METHOD_INVALID",
  "LISTING_SIGNATURE_INVALID",
  "IDENTITY_PRESENTATION_INVALID",
  "LEGACY_LISTING_INVALID",
  "DECLARED_CONTENT_HASH_MISMATCH",
] as const;

export type ListingRejectionCode = typeof LISTING_REJECTION_CODES[number];

export interface ListingDiagnosticCoordinates {
  listingId: string;
  listingVersion: number;
}

/**
 * A current Listing declares its version; only the legacy `serviceId` shape
 * defaults to version 1, and only when `listingVersion` is absent. A missing
 * or malformed version must not be filled in, or a rejection would be shown
 * against another valid version.
 */
function boundedCoordinates(listingId: string, version: unknown): ListingDiagnosticCoordinates | undefined {
  // DACS-1 Listing schema: URL-safe ASCII, at most 128 characters.
  return /^[A-Za-z0-9._~-]{1,128}$/.test(listingId) && typeof version === "number" &&
      Number.isSafeInteger(version) && version >= 1
    ? { listingId, listingVersion: version }
    : undefined;
}

/**
 * Project bounded coordinates only after the caller authenticates the artifact
 * and its seller. The profile is selected the way `verifyListing` selects it:
 * an artifact with `dacsVersion` is a current Listing (`listingId`,
 * `listingVersion`); any other is the legacy SDK shape (`serviceId`, optional
 * `listingVersion`), whose extra members are never read. Returns `undefined`
 * when the identifier or version is missing, malformed or outside the Listing
 * schema's bounds.
 */
export function listingDiagnosticCoordinates(
  raw: Record<string, unknown>,
): ListingDiagnosticCoordinates | undefined {
  if ("dacsVersion" in raw) {
    return typeof raw.listingId === "string" ? boundedCoordinates(raw.listingId, raw.listingVersion) : undefined;
  }
  return typeof raw.serviceId === "string"
    ? boundedCoordinates(raw.serviceId, raw.listingVersion === undefined ? 1 : raw.listingVersion)
    : undefined;
}

/** What one anchor read shows: no bytes, bytes that fail verification, or a verified Listing and its binding failure. */
export type ListingAnchorEvidence =
  | { kind: "unread" }
  | { kind: "invalid"; code: ListingRejectionCode }
  | { kind: "verified"; contentHash: string; binding: ListingRejectionCode | null };

export interface ListingNoticeInput {
  evidence: ListingAnchorEvidence;
  /** The verified owner-signed registration names this anchor. */
  ownerSignedAnchor: boolean;
  /**
   * Normalized hashes for this anchor: those saved publisher-signed sources declare, whether an older such source
   * saved none, and the unsigned crawl hash, which counts only when no signed source declares the anchor.
   */
  declarations: { signed: readonly string[]; unknown: boolean; unsigned?: string };
  /** The code of the anchor's current public notice, if it has one. */
  heldCode?: ListingRejectionCode;
}

/** Keep the anchor's row as it is, clear it and admit the Listing, or record a rejection. */
export type ListingNoticeDecision =
  | { action: "hold" }
  | { action: "clear" }
  | { action: "record"; code: ListingRejectionCode; publicNotice: boolean; coordinates: boolean };

/**
 * Decide an anchor's notice from this pass's read and the saved evidence. A held public notice stands until a read
 * refutes it: an owner notice yields to any verified Listing, a hash notice once every saved signed declaration
 * matches the verified hash. Only an owner-signed pointer or a signed declaration makes a new notice public.
 */
export function decideListingNotice({ evidence, ownerSignedAnchor, declarations, heldCode }: ListingNoticeInput): ListingNoticeDecision {
  if (evidence.kind === "unread") return { action: "hold" };
  const verifiedHash = evidence.kind === "verified" ? evidence.contentHash : undefined;
  const heldStands = heldCode === "OWNER_CLAIM_BINDING" ? verifiedHash === undefined
    : heldCode === "DECLARED_CONTENT_HASH_MISMATCH" &&
      (declarations.unknown || declarations.signed.some((hash) => hash !== verifiedHash));
  if (heldStands) return { action: "hold" };
  if (evidence.kind === "invalid") return { action: "record", code: evidence.code, publicNotice: false, coordinates: false };
  if (evidence.binding) {
    return { action: "record", code: evidence.binding, coordinates: evidence.binding !== "SELLER_CLAIM_BINDING",
      publicNotice: evidence.binding === "OWNER_CLAIM_BINDING" && ownerSignedAnchor };
  }
  const declared = declarations.signed.length > 0 ? declarations.signed : declarations.unsigned ? [declarations.unsigned] : [];
  return declared.some((hash) => hash !== evidence.contentHash)
    ? { action: "record", code: "DECLARED_CONTENT_HASH_MISMATCH", publicNotice: declarations.signed.length > 0, coordinates: true }
    : { action: "clear" };
}

export const LISTING_REJECTION_MESSAGES: Record<ListingRejectionCode, string> = {
  SELLER_CLAIM_BINDING: "The authenticated listing candidate seller does not match the registration claim.",
  OWNER_CLAIM_BINDING: "The listing anchor owner does not match the registration claim.",
  NORMATIVE_LISTING_INVALID: "The current listing does not satisfy the patched SDK validator or this Directory's catalog profile, including the LR-2 16,384-byte canonical Listing limit (signature omitted).",
  VERIFICATION_METHOD_INVALID: "The listing deliverable verification method is missing or is not a registered structured variant.",
  LISTING_SIGNATURE_INVALID: "The listing signature is malformed, unsupported, unresolved, or cryptographically invalid.",
  IDENTITY_PRESENTATION_INVALID: "The listing seller identity presentation could not be authenticated.",
  LEGACY_LISTING_INVALID: "The artifact does not satisfy the SDK's explicit legacy Listing read profile.",
  DECLARED_CONTENT_HASH_MISMATCH: "The discovery channel's declared listing content hash does not match the verified artifact.",
};

export const LISTING_REJECTION_GUIDANCE: Record<ListingRejectionCode, string> = {
  SELLER_CLAIM_BINDING: "Use pointers belonging to the registration's seller. This rejection does not change another seller's listing.",
  OWNER_CLAIM_BINDING: "Correct the registration's storage pointer to an anchor owned by the seller.",
  DECLARED_CONTENT_HASH_MISMATCH: "Correct the declared hash in the discovery channel, such as the hosted listings index, then reindex.",
  NORMATIVE_LISTING_INVALID: "This historical candidate remains rejected. Corrected replacement terms need a new signed Listing version or a new Listing ID; no action is required for an archived offer.",
  VERIFICATION_METHOD_INVALID: "This historical candidate remains rejected. A replacement needs a structured verification method in a new signed Listing version or under a new Listing ID; no action is required for an archived offer.",
  LISTING_SIGNATURE_INVALID: "Check the original anchor and signature encoding. This diagnostic does not identify an authenticated listing.",
  IDENTITY_PRESENTATION_INVALID: "Check the original identity presentation. This diagnostic does not identify an authenticated seller.",
  LEGACY_LISTING_INVALID: "Check the storage pointer and original artifact format. This diagnostic does not identify an authenticated listing.",
};
