import { countableDeals, inCategory } from "./settlementUniqueness.js";
import type { Catalog, ListingSummary, ReputationHint, SellerRecord } from "./types.js";

export const COMPLETION_VERIFICATION_UNAVAILABLE = "Completion verification unavailable";

// TP-1 (docs/TP-1.md): completion cannot yet be verified on testnet. Apply this
// on reads as well as indexing so a catalog cached by an older release is safe
// to serve.
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

const isSafeUint = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// The pinned SDK reader's canonical string: non-empty, trimmed, NFC, no C0 controls or DEL.
const isCanonicalString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value === value.trim() &&
  value === value.normalize("NFC") && !/[\u0000-\u001f\u007f]/.test(value);

// The pinned SDK catalog reader marks a whole page malformed when one hint
// fails its DACS-1 §6.3.6 shape check, so a cached hint is reused only when it
// passes the same check (the rate fields are always replaced with null).
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

function listingObservationHint(seller: SellerRecord, listing: ListingSummary, generatedAt: number): ReputationHint {
  // A missing or malformed cached hint must still have the count/window shape
  // the SDK catalog reader requires. The count is always recomputed from the
  // retained records with the indexer's SB-2 rule, so a hint cached before a
  // collision was excluded cannot keep counting it; no completion authority
  // follows from these records.
  const category = listing.offering?.category ?? "";
  const hint = isServableCachedHint(listing.reputationHint, category) ? listing.reputationHint : {
    categoryScope: category,
    windowStart: 0,
    windowEnd: generatedAt,
    computedAt: generatedAt,
  };
  const bundleCount = countableDeals(seller.deals ?? [], hint.windowStart, hint.windowEnd).deals
    .filter((deal) => inCategory(deal, hint.categoryScope)).length;
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

export function projectTestnetCatalog(catalog: Catalog): Catalog {
  return {
    ...catalog,
    sellers: catalog.sellers.map((seller) => ({
      ...withoutMetricKeys(seller),
      ...(seller.deals ? {
        deals: seller.deals.map((deal) => ({
          ...withoutMetricKeys(deal),
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
          ...withoutMetricKeys(listing),
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
