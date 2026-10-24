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
  (count === undefined ? "Observed outcomes unavailable, not verified" : `Observed outcomes: ${count}, not verified`);

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
 * TP-1 rule 2. The JSON API refuses every undocumented query name. Human
 * discovery ignores unrelated names (including tracking parameters), while
 * both surfaces explicitly refuse rate/score filters and ranking requests.
 * The message never echoes the name.
 */
export function unavailableMetricQuery(params: URLSearchParams, surface: "api" | "discovery" = "api"): string | undefined {
  // Rate, rating, score and ordering words in any segment of a bracketed
  // (`filter[x]`, `x[gte]`), dotted (`x.gte`) or `_`/`-` separated name, or
  // in a filter wrapper's value (`filter=completionRate`). On the strict API
  // all unknown names may supply the rate-specific error; human tracking
  // values such as `utm_campaign=rating` are unrelated to filtering.
  const metricWord = /^(?:rate|rating|score|completionrate|faultrate|trackrecord|(?:min|max)(?:completionrate|faultrate|rating|score))$/;
  const hasMetricWord = (text: string): boolean => {
    const words = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);
    return words.some((word) => metricWord.test(word)) || /\btrack record\b/.test(words.join(" "));
  };
  const rankingWord = /^(?:sort(?:by|order|key|direction|dir)?|order(?:by|direction)?|rank(?:by|ing)?|direction|dir)$/;
  const hasRankingWord = (text: string): boolean => text.toLowerCase().replace(/[_-]/g, "")
    .split(/[[\].]+/).some((word) => rankingWord.test(word));
  const rateReason = `Rate and score filters are unavailable on testnet under TP-1. ${COMPLETION_VERIFICATION_UNAVAILABLE}.`;
  for (const [name, value] of params) {
    if (LISTING_QUERY_PARAMETERS.includes(name)) continue;
    if (surface === "discovery" && /^utm_/i.test(name)) continue;
    const segments = name.toLowerCase().replace(/[_-]/g, "").split(/[[\].]+/).filter(Boolean);
    if (hasMetricWord(name)) return rateReason;
    if (hasRankingWord(name)) {
      return "Sorting and ranking are unavailable on testnet under TP-1.";
    }
    const filterWrapper = segments.some((segment) => /^filters?$/.test(segment));
    if ((surface === "api" || filterWrapper) && hasMetricWord(value)) return rateReason;
    if (filterWrapper && hasRankingWord(value)) return "Sorting and ranking are unavailable on testnet under TP-1.";
    if (surface === "discovery") continue;
    return "Unsupported listing query parameter. Only the documented listing filters are accepted; " +
      "rate filters, sorting and ranking are unavailable on testnet under TP-1.";
  }
}
