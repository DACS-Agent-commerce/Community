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
  const scoped = deals.filter((deal) =>
    deal.refsVerified && deal.reputationEligible &&
    typeof deal.finalisedAt === "number" && deal.finalisedAt >= windowStart && deal.finalisedAt <= windowEnd &&
    CURRENT_OUTCOMES.has(deal.sellerOutcome ?? ""),
  );
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
    anchor: { kind: "storage-program" as const, locator: deal.sellerBundleRef ?? deal.buyerBundleRef },
  })).sort((a, b) => a.contentHash.localeCompare(b.contentHash));
  return {
    completed,
    totalAgreements: scoped.length,
    completionRate: partyFaultDenominator > 0 ? completed / partyFaultDenominator : null,
    counterpartyAdjustedCompletionRate: blameDenominator > 0 ? completed / blameDenominator : null,
    counterpartyFaultRate: partyFaultDenominator > 0 ? counterpartyFault / partyFaultDenominator : null,
    averageBuyerRating: null,
    averageSellerRating: null,
    bundleRefs,
    windowStart,
    windowEnd,
    windowingBasis: "finalisedAt",
  };
}
