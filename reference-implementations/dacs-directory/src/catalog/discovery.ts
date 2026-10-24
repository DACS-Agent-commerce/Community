import { canonicalDemosAgentClaim } from "./claimRef.js";
import type { Catalog, ListingSummary, SellerRecord } from "./types.js";

/**
 * CF-3 identity of a ClaimReference: its scheme and identifier, with advisory
 * parameters dropped. Listing links carry it, and the listing routes match a
 * summary's seller by it, so a primaryClaim with parameters still resolves.
 */
export const sellerIdentity = (claim: string): string => canonicalDemosAgentClaim(claim) ?? claim;

/** Historical rail aliases are retained for evidence. A current offer needs
 * at least one rail other than those aliases, or a pipeline without payment. */
export const activeOffer = (listing: ListingSummary): boolean => listing.status === "active" &&
  !(listing.artifactProfile === "dacs-v0.1" && listing.offering.rails?.length && listing.offering.rails.every((rail) => rail === "pay-dem" || rail === "pay-x402"));

/** Public discovery advertises active, executable offers only. */
export const activeCatalogListings = (catalog: Catalog): ListingSummary[] =>
  catalog.sellers.flatMap((seller) => seller.listings).filter(activeOffer);

/** Remove revoked offers and sellers with no remaining active service. */
export const activeCatalogSellers = (sellers: SellerRecord[]): SellerRecord[] =>
  sellers
    .map((seller) => ({
      ...seller,
      listings: seller.listings.filter(activeOffer),
    }))
    .filter((seller) => seller.listings.length > 0);

/** Bound public query work before parsing untrusted ClaimReferences. */
export const MAX_CLAIM_QUERY_BYTES = 1024;

/** Compile once per request; callers supply the canonical seller-record key. */
export function primaryClaimPredicate(filter: string): (identity: string) => boolean {
  const canonicalFilter = sellerIdentity(filter).toLowerCase();
  return (identity) => {
    const claim = identity.toLowerCase();
    return claim === canonicalFilter || claim.startsWith(canonicalFilter + ":");
  };
}

/** Match either one exact canonical claim or a claim-scheme/prefix filter. */
export function primaryClaimMatches(claim: string, filter: string): boolean {
  return primaryClaimPredicate(filter)(sellerIdentity(claim));
}

/** Machine discovery retains authenticated withdrawal records. */
export const discoveryListing = (listing: ListingSummary): boolean => activeOffer(listing) || listing.status === "revoked" && Boolean(listing.revocation);
