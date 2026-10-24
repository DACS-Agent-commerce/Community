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
