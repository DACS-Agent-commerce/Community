import { canonicalDemosAgentClaim } from "./claimRef.js";
import type { Catalog, ListingSummary, SellerRecord } from "./types.js";

/**
 * A current summary's `seller.primaryClaim` carries the listing's exact
 * `presentedBy` bytes (§6.3.6 / RB-2), CF-3 parameters included; seller
 * records, lookups and links use its parameter-free CF-3 identity.
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

/** Match either one exact canonical claim or a claim-scheme/prefix filter. */
export function primaryClaimMatches(claim: string, filter: string): boolean {
  const canonicalClaim = claim.toLowerCase();
  const canonicalFilter = filter.toLowerCase();
  return canonicalClaim === canonicalFilter || canonicalClaim.startsWith(canonicalFilter + ":");
}

/** Machine discovery retains authenticated withdrawal records. */
export const discoveryListing = (listing: ListingSummary): boolean => activeOffer(listing) || listing.status === "revoked" && Boolean(listing.revocation);
