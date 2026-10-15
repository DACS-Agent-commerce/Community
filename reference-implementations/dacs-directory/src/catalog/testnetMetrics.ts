import type { Catalog } from "./types.js";

export const COMPLETION_VERIFICATION_UNAVAILABLE = "Completion verification unavailable";

// DEC-11: completion cannot yet be verified on testnet. Apply this on reads
// as well as indexing so a catalog cached by an older release is safe to serve.
export const UNAVAILABLE_TESTNET_METRICS = {
  completionRate: null,
  counterpartyAdjustedCompletionRate: null,
  counterpartyFaultRate: null,
  averageBuyerRating: null,
  averageSellerRating: null,
  metricsUnavailableReason: COMPLETION_VERIFICATION_UNAVAILABLE,
} as const;

export const observedOutcomesLabel = (count: number): string =>
  `Observed outcomes: ${count}, not verified`;

export function projectTestnetCatalog(catalog: Catalog): Catalog {
  return {
    ...catalog,
    sellers: catalog.sellers.map((seller) => ({
      ...seller,
      ...(seller.deals ? {
        deals: seller.deals.map((deal) => ({
          ...deal,
          ...(deal.ratings ? {
            ratings: deal.ratings.map((rating) => ({
              ...rating,
              value: null,
              metricsUnavailableReason: COMPLETION_VERIFICATION_UNAVAILABLE,
            })),
          } : {}),
        })),
      } : {}),
      ...(seller.reputation ? {
        reputation: {
          ...seller.reputation,
          ...UNAVAILABLE_TESTNET_METRICS,
          observedOutcomesLabel: observedOutcomesLabel(seller.reputation.totalAgreements),
        },
      } : {}),
      ...(seller.listings ? {
        listings: seller.listings.map((listing) => ({
          ...listing,
          ...(listing.reputationHint ? {
            reputationHint: {
              ...listing.reputationHint,
              ...UNAVAILABLE_TESTNET_METRICS,
              observedOutcomesLabel: observedOutcomesLabel(listing.reputationHint.bundleCount),
            },
          } : {}),
        })),
      } : {}),
    })),
  };
}

export function unavailableMetricQuery(params: URLSearchParams): string | undefined {
  for (const name of params.keys()) {
    if (/(?:rates?$|rating|reputation|score|trackrecord|^(?:sort|order|rank))/i.test(name)) {
      return `${name}: rate and score filters and ranking are unavailable on testnet. ${COMPLETION_VERIFICATION_UNAVAILABLE}.`;
    }
  }
}
