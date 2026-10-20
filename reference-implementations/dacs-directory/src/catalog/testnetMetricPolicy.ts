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

export const OBSERVED_REPUTATION_COUNTS = {
  completedLabel: "Observed completed outcomes, not verified",
  totalAgreementsLabel: "Observed outcomes, not verified",
  observedTransactionalVolumeLabel: "Observed amounts in completed outcomes, not verified completion or settlement",
  transactionCountByCurrencyLabel: "Observed priced completed outcomes, not verified completion or settlement",
} as const;

export function unavailableMetricQuery(params: URLSearchParams): string | undefined {
  const metricKeys = new Set([
    "mincompletionrate", "minrating", "trackrecord", "maxfaultrate", "faultrate",
    "completionrate", "counterpartyadjustedcompletionrate", "counterpartyfaultrate",
    "averagebuyerrating", "averagesellerrating", "reputationscore",
  ]);
  const rankingKeys = new Set(["sort", "sortby", "order", "orderby", "rank", "rankby", "ranking"]);
  // No listing query parameter contains these words, so any name that does is
  // a rate, rating or score filter however it is nested or suffixed.
  const metricWord = /completionrate|faultrate|rating|score|trackrecord/;
  for (const name of params.keys()) {
    // Bracketed (`filter[x]`, `x[gte]`) and dotted (`x.gte`) forms and `_`/`-`
    // separators spell the same filter, so every segment is checked.
    const segments = name.toLowerCase().replace(/[_-]/g, "").split(/[[\].]+/).filter(Boolean);
    if (segments.some((segment) => metricKeys.has(segment)) || metricWord.test(segments.join(""))) {
      return `Rate and score filters are unavailable on testnet under TP-1. ${COMPLETION_VERIFICATION_UNAVAILABLE}.`;
    }
    if (segments.some((segment) => rankingKeys.has(segment))) {
      return "Sorting and ranking are unavailable on testnet under TP-1.";
    }
  }
}
