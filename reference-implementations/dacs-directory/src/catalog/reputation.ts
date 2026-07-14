import type { DealRecord, SellerRecord } from "./types.js";

const CURRENT_OUTCOMES = new Set([
  "completed", "failed-perm", "failed-counterparty", "failed-substrate",
  "aborted-by-self", "aborted-by-other",
]);

export function flipOutcome(outcome: string | undefined): string | undefined {
  if (outcome === "aborted-by-self") return "aborted-by-other";
  if (outcome === "aborted-by-other") return "aborted-by-self";
  if (outcome === "failed-perm") return "failed-counterparty";
  if (outcome === "failed-counterparty") return "failed-perm";
  return outcome;
}

export function isNeutralCancellation(
  sellerOutcome: string | undefined,
  cancellation: unknown,
  listingTerms: unknown,
  phaseSummary: unknown,
): boolean {
  const marker = cancellation && typeof cancellation === "object" && !Array.isArray(cancellation)
    ? cancellation as Record<string, unknown> : undefined;
  const terms = listingTerms && typeof listingTerms === "object" && !Array.isArray(listingTerms)
    ? listingTerms as Record<string, unknown> : undefined;
  const phases = Array.isArray(phaseSummary) ? phaseSummary.filter((phase): phase is Record<string, unknown> =>
    Boolean(phase && typeof phase === "object" && !Array.isArray(phase))) : [];
  const commitReached = phases.some((phase) => phase.kind === "commit-agreement" && phase.outcome === "ok");
  return (sellerOutcome === "aborted-by-self" || sellerOutcome === "aborted-by-other") &&
    marker?.claimedPolicy === "pre-commit" && terms?.cancellationPolicy === "pre-commit" && !commitReached;
}

/**
 * DACS-5 scalar derivation over already signature/reference-verified,
 * seller-perspective records. Reconciliation and divergence exclusion happen
 * before this function; unresolved ratings/volume intentionally remain absent.
 */
export function deriveSellerReputation(
  deals: DealRecord[],
  windowStart = 0,
  windowEnd = Date.now(),
): SellerRecord["reputation"] {
  let scoped = deals.filter((deal) =>
    deal.refsVerified && deal.reputationEligible &&
    typeof (deal.anchorTimestamp ?? deal.finalisedAt) === "number" &&
    (deal.anchorTimestamp ?? deal.finalisedAt)! >= windowStart && (deal.anchorTimestamp ?? deal.finalisedAt)! <= windowEnd &&
    CURRENT_OUTCOMES.has(deal.sellerOutcome ?? ""),
  );
  // SB-2: a settlement transaction reused across jobs contributes once, at
  // its earliest evidence observation. Deterministic jobId breaks exact ties.
  const settlementOwner = new Map<string, DealRecord>();
  for (const deal of scoped) for (const tx of deal.settlementTxIds ?? []) {
    const prior = settlementOwner.get(tx.id);
    const priorTime = prior?.settlementTxIds?.find((candidate) => candidate.id === tx.id)?.observedAt ?? Infinity;
    if (!prior || tx.observedAt < priorTime || (tx.observedAt === priorTime && deal.jobId < prior.jobId)) settlementOwner.set(tx.id, deal);
  }
  scoped = scoped.filter((deal) => !(deal.settlementTxIds ?? []).some((tx) => settlementOwner.get(tx.id) !== deal));
  const completed = scoped.filter((deal) => deal.sellerOutcome === "completed").length;
  const neutral = scoped.filter((deal) => deal.sellerOutcome === "failed-substrate" || deal.cancellationNeutral).length;
  const counterpartyFault = scoped.filter((deal) => !deal.cancellationNeutral &&
    (deal.sellerOutcome === "failed-counterparty" || deal.sellerOutcome === "aborted-by-other")).length;
  const partyFaultDenominator = scoped.length - neutral;
  const blameDenominator = partyFaultDenominator - counterpartyFault;
  const bundleRefs = scoped.filter((deal) => deal.bundleContentHash).map((deal) => ({
    kind: "dacs-5-bundle" as const,
    id: deal.jobId,
    contentHash: deal.bundleContentHash!,
    anchor: {
      kind: "storage-program" as const,
      locator: deal.anchoredByRole === "buyer" ? deal.buyerBundleRef : deal.sellerBundleRef ?? deal.buyerBundleRef,
    },
  })).sort((a, b) => a.contentHash.localeCompare(b.contentHash));
  const ratingByDirection = new Map<string, NonNullable<DealRecord["ratings"]>[number]>();
  for (const deal of scoped) for (const rating of deal.ratings ?? []) {
    if (rating.target.toLowerCase() !== deal.owners.seller.toLowerCase() || rating.rater.toLowerCase() === rating.target.toLowerCase()) continue;
    const key = `${rating.rater.toLowerCase()}\n${deal.jobId}\n${rating.targetRole}`;
    const prior = ratingByDirection.get(key);
    if (!prior || rating.ratedAt > prior.ratedAt || (rating.ratedAt === prior.ratedAt && rating.contentHash > prior.contentHash)) ratingByDirection.set(key, rating);
  }
  const sellerRatings = [...ratingByDirection.values()].filter((rating) => rating.targetRole === "seller").map((rating) => rating.value);
  const completedWithPrice = scoped.filter((deal) => deal.sellerOutcome === "completed" && deal.agreementPrice);
  const amounts = new Map<string, string[]>();
  for (const deal of completedWithPrice) {
    const price = deal.agreementPrice!;
    amounts.set(price.currency, [...(amounts.get(price.currency) ?? []), price.amount]);
  }
  const observedTransactionalVolume = [...amounts].map(([currency, values]) => ({ currency, amount: sumDecimals(values) }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
  const transactionCountByCurrency = [...amounts].map(([currency, values]) => ({ currency, count: values.length }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
  return {
    completed,
    bundleCount: scoped.length,
    totalAgreements: scoped.length,
    completionRate: partyFaultDenominator > 0 ? completed / partyFaultDenominator : null,
    counterpartyAdjustedCompletionRate: blameDenominator > 0 ? completed / blameDenominator : null,
    counterpartyFaultRate: partyFaultDenominator > 0 ? counterpartyFault / partyFaultDenominator : null,
    // This catalog record is seller-scoped. Buyer-side sessions are not part
    // of its input set, so surfacing a buyer rating here would invent signal.
    averageBuyerRating: null,
    averageSellerRating: sellerRatings.length ? sellerRatings.reduce((a, b) => a + b, 0) / sellerRatings.length : null,
    observedTransactionalVolume,
    transactionCountByCurrency,
    bundleRefs,
    windowStart,
    windowEnd,
    windowingBasis: scoped.some((deal) => deal.anchorTimestamp !== undefined) ? "sr2-anchor-timestamp" : "finalisedAt",
  };
}

/** Exact non-negative decimal addition without binary floating-point drift. */
function sumDecimals(values: string[]): string {
  let scale = 0;
  const parsed = values.map((value) => {
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
    const [whole, fraction = ""] = value.split(".");
    scale = Math.max(scale, fraction.length);
    return { whole, fraction };
  });
  if (parsed.some((value) => !value)) return "0";
  const total = parsed.reduce((sum, value) => sum + BigInt(value!.whole + value!.fraction.padEnd(scale, "0")), 0n);
  const digits = total.toString().padStart(scale + 1, "0");
  if (!scale) return digits;
  const result = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, "");
  return result || "0";
}
