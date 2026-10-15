import type { Catalog, ListingSummary, ReputationHint, SellerRecord } from "./types.js";

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
  metricsProfile: "TP-1",
} as const;

export const observedOutcomesLabel = (count: number | undefined): string =>
  count === undefined ? "Observed outcomes unavailable, not verified" : `Observed outcomes: ${count}, not verified`;

export const OBSERVED_REPUTATION_COUNTS = {
  completedLabel: "Observed completed outcomes, not verified",
  totalAgreementsLabel: "Observed outcomes, not verified",
  observedTransactionalVolumeLabel: "Observed amounts in completed outcomes, not verified completion or settlement",
  transactionCountByCurrencyLabel: "Observed priced completed outcomes, not verified completion or settlement",
} as const;

function listingObservationHint(seller: SellerRecord, listing: ListingSummary, generatedAt: number): ReputationHint {
  // Match the indexer's existing category-scoped observation count. A missing
  // cached hint must still have the count/window shape the SDK catalog reader
  // requires; no completion authority follows from these retained records.
  const category = listing.offering?.category ?? "";
  const hint = listing.reputationHint ?? {
    categoryScope: category,
    bundleCount: (seller.deals ?? []).filter((deal) =>
      deal.refsVerified && deal.reputationEligible &&
      (deal.category === category || deal.category?.startsWith(`${category}.`)),
    ).length,
    windowStart: 0,
    windowEnd: generatedAt,
    computedAt: generatedAt,
  };
  return {
    categoryScope: hint.categoryScope,
    bundleCount: hint.bundleCount,
    windowStart: hint.windowStart,
    windowEnd: hint.windowEnd,
    computedAt: hint.computedAt,
    ...UNAVAILABLE_TESTNET_METRICS,
    observedOutcomesLabel: observedOutcomesLabel(hint.bundleCount),
  };
}

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
              rater: rating.rater,
              target: rating.target,
              targetRole: rating.targetRole,
              ratedAt: rating.ratedAt,
              contentHash: rating.contentHash,
              value: null,
              metricsUnavailableReason: COMPLETION_VERIFICATION_UNAVAILABLE,
            })),
          } : {}),
        })),
      } : {}),
      ...(seller.reputation ? {
        reputation: {
          completed: seller.reputation.completed,
          totalAgreements: seller.reputation.totalAgreements,
          bundleCount: seller.reputation.bundleCount,
          windowStart: seller.reputation.windowStart,
          windowEnd: seller.reputation.windowEnd,
          windowingBasis: seller.reputation.windowingBasis,
          bundleRefs: seller.reputation.bundleRefs?.map((ref) => ({
            kind: ref.kind, id: ref.id, contentHash: ref.contentHash,
            anchor: { kind: ref.anchor.kind, locator: ref.anchor.locator },
          })),
          observedTransactionalVolume: seller.reputation.observedTransactionalVolume?.map(({ currency, amount }) => ({ currency, amount })),
          transactionCountByCurrency: seller.reputation.transactionCountByCurrency?.map(({ currency, count }) => ({ currency, count })),
          ...UNAVAILABLE_TESTNET_METRICS,
          ...OBSERVED_REPUTATION_COUNTS,
          observedOutcomesLabel: observedOutcomesLabel(seller.reputation.totalAgreements),
        },
      } : {}),
      ...(seller.listings ? {
        listings: seller.listings.map((listing) => ({
          ...listing,
          reputationHint: listingObservationHint(seller, listing, catalog.generatedAt),
        })),
      } : {}),
    })),
  };
}

export function unavailableMetricQuery(params: URLSearchParams): string | undefined {
  const metricKeys = new Set([
    "mincompletionrate", "minrating", "trackrecord", "maxfaultrate", "faultrate",
    "completionrate", "counterpartyadjustedcompletionrate", "counterpartyfaultrate",
    "averagebuyerrating", "averagesellerrating", "reputationscore",
  ]);
  const rankingKeys = new Set(["sort", "sortby", "order", "orderby", "rank", "rankby"]);
  for (const name of params.keys()) {
    const key = name.replace(/(?:\[\])+$/, "").toLowerCase();
    if (metricKeys.has(key)) {
      return `Rate and score filters are unavailable on testnet under TP-1. ${COMPLETION_VERIFICATION_UNAVAILABLE}.`;
    }
    if (rankingKeys.has(key)) {
      return "Sorting and ranking are unavailable on testnet under TP-1.";
    }
  }
}
