import { isLegacyMvpListing, type LegacyMvpListing } from "@kynesyslabs/dacs/artifacts";

/**
 * True when the scope has the members every historical SDK Listing carries.
 * The draft SDK never validated pricing or listingVersion, and its Listings
 * include metered or free-form pricing, so those two members are not judged
 * here. Returns false for anything that is not a plain object.
 */
export function isHistoricalListing(scope: unknown): scope is LegacyMvpListing {
  return typeof scope === "object" && scope !== null && !Array.isArray(scope) &&
    isLegacyMvpListing({ ...scope, pricing: undefined, listingVersion: undefined });
}
