import type { Catalog, ListingSummary, SellerRecord } from "./types.js";

/** Historical signed phase-name aliases are retained for evidence, but cannot be executed
 * under the current registry. Publishers must issue a new signed version with canonical IDs. */
const activeOffer = (listing: ListingSummary): boolean => listing.status === "active" &&
  !(listing.artifactProfile === "dacs-v0.1" && listing.offering.rails?.some((rail) => rail === "pay-dem" || rail === "pay-x402"));

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
