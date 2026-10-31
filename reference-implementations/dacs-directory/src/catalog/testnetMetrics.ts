import { deriveSellerReputation } from "./reputation.js";
import type { Catalog, DealRecord, ListingSummary, ReputationHint } from "./types.js";

import {
  COMPLETION_VERIFICATION_UNAVAILABLE, UNAVAILABLE_TESTNET_METRICS, observedOutcomesLabel,
} from "./testnetMetricPolicy.js";
export * from "./testnetMetricPolicy.js";

const isSafeUint = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// Directory hint scopes use non-empty, trimmed NFC text without C0 controls or DEL.
const isCanonicalString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value === value.trim() &&
  value === value.normalize("NFC") && !/[\u0000-\u001f\u007f]/.test(value);

// Reuse cached scope/window metadata only when it satisfies this Directory
// contract. The scope relationship comes from DACS-1 §6.3.6; safe integer
// timestamps and canonical text are local validation choices, not SDK requirements.
function isServableCachedHint(hint: ReputationHint | undefined, category: string): hint is ReputationHint {
  return Boolean(hint) && isCanonicalString(hint!.categoryScope) &&
    (category === hint!.categoryScope || category.startsWith(`${hint!.categoryScope}.`)) &&
    isSafeUint(hint!.bundleCount) && isSafeUint(hint!.windowStart) && isSafeUint(hint!.windowEnd) &&
    hint!.windowStart <= hint!.windowEnd && isSafeUint(hint!.computedAt);
}

// TP-1 allowlists the reputation, hint and rating shapes; any other rate,
// rating or score a cached catalog carries at seller, deal or listing level is
// dropped too. No current field at those levels ends in these words.
const UNAVAILABLE_METRIC_KEY = /(?:rate|rating|score)$/i;
function withoutMetricKeys<T extends object>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !UNAVAILABLE_METRIC_KEY.test(key))) as T;
}

function listingObservationHint(listing: ListingSummary, generatedAt: number, deals: DealRecord[], counts: Map<string, number>): ReputationHint {
  const category = listing.offering?.category ?? "";
  const hint = isServableCachedHint(listing.reputationHint, category) ? listing.reputationHint : {
    categoryScope: category,
    windowStart: 0,
    windowEnd: generatedAt,
    computedAt: generatedAt,
  };
  const scopeKey = JSON.stringify([hint.categoryScope, hint.windowStart, hint.windowEnd]);
  let bundleCount = counts.get(scopeKey);
  if (bundleCount === undefined) {
    const categoryDeals = deals.filter((deal) => deal.category === hint.categoryScope || Boolean(deal.category?.startsWith(hint.categoryScope + ".")));
    bundleCount = deriveSellerReputation(categoryDeals, hint.windowStart, hint.windowEnd).bundleCount ?? 0;
    counts.set(scopeKey, bundleCount);
  }
  return {
    categoryScope: hint.categoryScope,
    bundleCount,
    windowStart: hint.windowStart,
    windowEnd: hint.windowEnd,
    computedAt: hint.computedAt,
    ...UNAVAILABLE_TESTNET_METRICS,
    observedOutcomesLabel: observedOutcomesLabel(bundleCount),
  };
}
/** Public projection never changes the evidence retained by catalog writers. */
export function projectTestnetCatalog(catalog: Catalog): Catalog {
  const observed = {
    ...catalog,
    sellers: catalog.sellers.map((seller) => {
      const counts = new Map<string, number>();
      return {
        ...seller,
        reputation: deriveSellerReputation(seller.deals ?? [], seller.reputation?.windowStart ?? 0, seller.reputation?.windowEnd ?? catalog.generatedAt),
        listings: (seller.listings ?? []).map((listing) => ({
          ...listing, reputationHint: listingObservationHint(listing, catalog.generatedAt, seller.deals ?? [], counts),
        })),
      };
    }),
  };
  return {
    ...observed,
    sellers: observed.sellers.map((seller) => ({
      ...withoutMetricKeys(seller),
      deals: (seller.deals ?? []).map((deal) => ({
        ...withoutMetricKeys(deal),
        ...(deal.ratings ? {
          ratings: deal.ratings.map((rating) => ({
            rater: rating.rater, target: rating.target, targetRole: rating.targetRole,
            ratedAt: rating.ratedAt, contentHash: rating.contentHash,
            value: null,
            metricsUnavailableReason: COMPLETION_VERIFICATION_UNAVAILABLE,
          })),
        } : {}),
      })),
      listings: (seller.listings ?? []).map(withoutMetricKeys),
    })),
  };
}
