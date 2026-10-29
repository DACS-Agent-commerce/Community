import { canonicalDemosAgentClaim } from "./claimRef.js";
import type { Catalog, ListingSummary, SellerRecord } from "./types.js";

/**
 * CF-3 identity of a ClaimReference: its scheme and identifier, with advisory
 * parameters dropped. A current summary's `seller.primaryClaim` carries the
 * Listing's exact `presentedBy` bytes; seller records, lookups and links use
 * this identity, so a primaryClaim with parameters still resolves.
 */
export const sellerIdentity = (claim: string): string => canonicalDemosAgentClaim(claim) ?? claim;

/** Largest ClaimReference, in UTF-8 bytes, that a summary publishes or a query accepts. */
export const MAX_CLAIM_QUERY_BYTES = 1024;

/** Whether a ClaimReference, measured exactly as given (untrimmed), is over MAX_CLAIM_QUERY_BYTES in UTF-8. */
export const exceedsClaimBound = (claim: string): boolean =>
  new TextEncoder().encode(claim).byteLength > MAX_CLAIM_QUERY_BYTES;

/**
 * The one publication gate for a summary's exact seller reference: the reason
 * the summary is withheld, or null when it can be published. A withheld
 * summary's signed Listing still serves as deal evidence.
 */
export function summaryPublicationRefusal(summaryClaim: string): string | null {
  return exceedsClaimBound(summaryClaim) ? `seller reference exceeds ${MAX_CLAIM_QUERY_BYTES} bytes` : null;
}

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
