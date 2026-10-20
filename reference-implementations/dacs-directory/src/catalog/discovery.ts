import { canonicalDemosAgentClaim } from "./claimRef.js";
import type { Catalog, ListingSummary, SellerRecord } from "./types.js";

/**
 * A current summary's `seller.primaryClaim` carries the listing's exact
 * `presentedBy` bytes (§6.3.6 / RB-2), CF-3 parameters included; seller
 * records, lookups and links use its parameter-free CF-3 identity.
 */
export const sellerIdentity = (claim: string): string => canonicalDemosAgentClaim(claim) ?? claim;

/** Public discovery advertises active offers only; revoked entries are history. */
export const activeCatalogListings = (catalog: Catalog): ListingSummary[] =>
  catalog.sellers.flatMap((seller) => seller.listings).filter((listing) => listing.status === "active");

/** Remove revoked offers and sellers with no remaining active service. */
export const activeCatalogSellers = (sellers: SellerRecord[]): SellerRecord[] =>
  sellers
    .map((seller) => ({
      ...seller,
      listings: seller.listings.filter((listing) => listing.status === "active"),
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
