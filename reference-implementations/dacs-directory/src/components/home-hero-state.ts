import { activeCatalogListings, activeCatalogSellers } from "../catalog/discovery.js";
import type { Catalog } from "../catalog/types.js";

export type HomeCatalogDisplayState = "indexing" | "empty" | "summary";

export function homeCatalogDisplayState(
  indexed: boolean,
  activeListingCount: number,
): HomeCatalogDisplayState {
  if (!indexed) return "indexing";
  return activeListingCount > 0 ? "summary" : "empty";
}

export interface HomeCatalogSummary {
  activeServices: number;
  sellers: number;
  verifiedDeals: number;
  freshness: { value: string; label: string };
}

const FRESHNESS_LABELS: Record<HomeCatalogDisplayState, string> = {
  indexing: "initial chain index",
  empty: "last index; no active listings",
  summary: "since last index",
};

/** The landing page's catalog summary strip, computed from the stored catalog. */
export function homeCatalogSummary(catalog: Catalog, now: number): HomeCatalogSummary {
  const sellers = activeCatalogSellers(catalog.sellers);
  const listings = activeCatalogListings(catalog);
  const indexed = catalog.generatedAt > 0;
  // A clock behind the indexer's still reads as "0m", never a negative age.
  const ageMinutes = indexed ? Math.max(0, Math.round((now - catalog.generatedAt) / 60_000)) : 0;
  const age = ageMinutes < 60 ? `${ageMinutes}m` : `${Math.round(ageMinutes / 60)}h`;
  return {
    activeServices: listings.length,
    sellers: sellers.length,
    verifiedDeals: sellers.reduce((sum, seller) => sum + seller.deals.filter((deal) => deal.refsVerified).length, 0),
    freshness: {
      value: indexed ? age : "pending",
      label: FRESHNESS_LABELS[homeCatalogDisplayState(indexed, listings.length)],
    },
  };
}
