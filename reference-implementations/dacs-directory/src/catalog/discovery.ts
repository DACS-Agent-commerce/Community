import type { Catalog, ListingSummary, SellerRecord } from "./types.js";

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
