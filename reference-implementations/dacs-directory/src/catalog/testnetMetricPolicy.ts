// Shared TP-1 text and query policy; safe for browser imports.
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

// Bundles whose signatures and referenced artifacts checked. This count is not
// gated by SB-2 or the projection version, so it is never called an outcome.
export const CHECKED_BUNDLES_LABEL = "signature-checked bundles; not counted as outcomes";

export const OBSERVED_REPUTATION_COUNTS = {
  completedLabel: "Observed completed outcomes, not verified",
  totalAgreementsLabel: "Observed outcomes, not verified",
  observedTransactionalVolumeLabel: "Observed amounts in completed outcomes, not verified completion or settlement",
  transactionCountByCurrencyLabel: "Observed priced completed outcomes, not verified completion or settlement",
} as const;

/**
 * The only query names the listings API reads (and the manifest's `filters`).
 * The pinned SDK catalog client sends a subset of these, plus the two rate
 * filters TP-1 removed.
 */
export const LISTING_QUERY_PARAMETERS: readonly string[] = [
  "category", "tag", "credential", "primaryClaim", "identityTier", "rail", "priceMax", "q", "profile", "limit", "cursor",
];

/**
 * TP-1 rule 2. Any query name outside LISTING_QUERY_PARAMETERS is refused,
 * whatever its spelling, so no rate filter or ordering request is answered
 * with an unfiltered, unsorted page. Rate and ranking names get the specific
 * reason; the message never echoes the name.
 */
export function unavailableMetricQuery(params: URLSearchParams): string | undefined {
  // Rate, rating, score and ordering words in any segment of a bracketed
  // (`filter[x]`, `x[gte]`), dotted (`x.gte`) or `_`/`-` separated name, or
  // in the value of an unknown name (`filter=completionRate`).
  const metricWord = /completionrate|faultrate|rating|score|trackrecord/;
  const rankingWord = /^(?:sort|order|rank|direction|dir$)/;
  const rateReason = `Rate and score filters are unavailable on testnet under TP-1. ${COMPLETION_VERIFICATION_UNAVAILABLE}.`;
  for (const [name, value] of params) {
    if (LISTING_QUERY_PARAMETERS.includes(name)) continue;
    const segments = name.toLowerCase().replace(/[_-]/g, "").split(/[[\].]+/).filter(Boolean);
    if (metricWord.test(segments.join(""))) return rateReason;
    if (segments.some((segment) => rankingWord.test(segment))) {
      return "Sorting and ranking are unavailable on testnet under TP-1.";
    }
    if (metricWord.test(value.toLowerCase().replace(/[_-]/g, ""))) return rateReason;
    return "Unsupported listing query parameter. Only the documented listing filters are accepted; " +
      "rate filters, sorting and ranking are unavailable on testnet under TP-1.";
  }
}
