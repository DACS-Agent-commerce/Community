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

/** Recover only bounded, public-safe coordinates from an otherwise rejected artifact. */
export function listingDiagnosticCoordinates(
  raw: Record<string, unknown>,
): ListingDiagnosticCoordinates | undefined {
  const listingId = typeof raw.listingId === "string"
    ? raw.listingId
    : typeof raw.serviceId === "string"
      ? raw.serviceId
      : undefined;
  const version = raw.listingVersion ?? raw.version ?? 1;
  return listingId && /^[a-z0-9-]{1,64}$/.test(listingId) &&
      Number.isSafeInteger(version) && Number(version) >= 1
    ? { listingId, listingVersion: Number(version) }
    : undefined;
}

export const LISTING_REJECTION_MESSAGES: Record<ListingRejectionCode, string> = {
  SELLER_CLAIM_BINDING: "The authenticated listing candidate seller does not match the registration claim.",
  OWNER_CLAIM_BINDING: "The listing anchor owner does not match the registration claim.",
  NORMATIVE_LISTING_INVALID: "The current listing does not satisfy the pinned SDK's normative Listing validator.",
  VERIFICATION_METHOD_INVALID: "The listing deliverable verification method is missing or is not a registered structured variant.",
  LISTING_SIGNATURE_INVALID: "The listing signature is malformed, unsupported, unresolved, or cryptographically invalid.",
  IDENTITY_PRESENTATION_INVALID: "The listing seller identity presentation could not be authenticated.",
  LEGACY_LISTING_INVALID: "The artifact does not satisfy the SDK's explicit legacy Listing read profile.",
  DECLARED_CONTENT_HASH_MISMATCH: "The discovery channel's declared listing content hash does not match the verified artifact.",
};
