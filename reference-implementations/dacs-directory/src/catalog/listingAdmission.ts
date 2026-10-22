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

/** Project bounded coordinates only after the caller authenticates the artifact and its seller. */
export function listingDiagnosticCoordinates(
  raw: Record<string, unknown>,
): ListingDiagnosticCoordinates | undefined {
  const listingId = typeof raw.listingId === "string"
    ? raw.listingId
    : typeof raw.serviceId === "string"
      ? raw.serviceId
      : undefined;
  const version = raw.listingVersion ?? raw.version ?? 1;
  // DACS-1 Listing schema: URL-safe ASCII, at most 128 characters.
  return listingId && /^[A-Za-z0-9._~-]{1,128}$/.test(listingId) &&
      Number.isSafeInteger(version) && Number(version) >= 1
    ? { listingId, listingVersion: Number(version) }
    : undefined;
}

export const LISTING_REJECTION_MESSAGES: Record<ListingRejectionCode, string> = {
  SELLER_CLAIM_BINDING: "The authenticated listing candidate seller does not match the registration claim.",
  OWNER_CLAIM_BINDING: "The listing anchor owner does not match the registration claim.",
  NORMATIVE_LISTING_INVALID: "The current listing does not satisfy the patched SDK validator or this Directory's catalog profile, including the SDK's stricter 16,384-byte limit on the complete canonical Listing with its signature.",
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
  NORMATIVE_LISTING_INVALID: "This historical candidate remains rejected. Corrected replacement terms need a new Listing ID; no action is required for an archived offer.",
  VERIFICATION_METHOD_INVALID: "This historical candidate remains rejected. A replacement needs a structured verification method and a new Listing ID; no action is required for an archived offer.",
  LISTING_SIGNATURE_INVALID: "Check the original anchor and signature encoding. This diagnostic does not identify an authenticated listing.",
  IDENTITY_PRESENTATION_INVALID: "Check the original identity presentation. This diagnostic does not identify an authenticated seller.",
  LEGACY_LISTING_INVALID: "Check the storage pointer and original artifact format. This diagnostic does not identify an authenticated listing.",
};
