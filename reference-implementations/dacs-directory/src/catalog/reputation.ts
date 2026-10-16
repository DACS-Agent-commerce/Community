import type { DealRecord, SellerRecord } from "./types.js";
import { observedOutcomesLabel, OBSERVED_REPUTATION_COUNTS, UNAVAILABLE_TESTNET_METRICS } from "./testnetMetrics.js";

// §10.5.3(2): determinism-receipt ordering is byte-order lexicographic. `String.localeCompare`
// is ICU/locale-collation dependent and is NOT guaranteed byte-stable across runtimes/locales,
// so two conforming implementations could emit different receipt bytes. Compare the raw UTF-8
// bytes directly to implement the specified ordering.
const byteOrder = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

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
  const commitReached = phases.some((phase) =>
    (phase.kind === "commit-agreement" || phase.kind === "commit-payee-bound-agreement") &&
    phase.outcome === "ok");
  return (sellerOutcome === "aborted-by-self" || sellerOutcome === "aborted-by-other") &&
    marker?.claimedPolicy === "pre-commit" && terms?.cancellationPolicy === "pre-commit" && !commitReached;
}

/**
 * Observed counts and evidence references over seller-perspective records.
 * Reconciliation and divergence exclusion happen before this function.
 * Testnet completion, fault rates and numeric reputation remain unavailable.
 */
export function deriveSellerReputation(
  deals: DealRecord[],
  windowStart = 0,
  windowEnd = Date.now(),
): SellerRecord["reputation"] {
  const eligible = deals.filter((deal) =>
    deal.refsVerified && deal.reputationEligible &&
    CURRENT_OUTCOMES.has(deal.sellerOutcome ?? ""),
  );
  // A determinism receipt declares one timestamp basis for its entire input
  // set. Use SR-2 anchor time only when it is available for every eligible
  // record; otherwise fall back to finalisedAt uniformly and exclude records
  // that cannot be evaluated on that honest basis.
  const useAnchorTimestamps = eligible.length > 0 &&
    eligible.every((deal) => typeof deal.anchorTimestamp === "number");
  const timestampOf = (deal: DealRecord) => useAnchorTimestamps
    ? deal.anchorTimestamp
    : deal.finalisedAt;
  let scoped = eligible.filter((deal) => {
    const timestamp = timestampOf(deal);
    return typeof timestamp === "number" && timestamp >= windowStart && timestamp <= windowEnd;
  });
  // DACS-4 SB-2: group the whole presented set by settlement id before counting.
  // Repeating one (jobId, phaseIndex) claim is idempotent. A group claimed by
  // two or more tuples is indeterminate without settlement-side binding
  // authority, which this Directory does not verify, so no member counts. The
  // producer-set observedAt, arrival and jobId order never pick a winner.
  const claimants = new Map<string, Set<string>>();
  for (const deal of scoped) for (const tx of deal.settlementTxIds ?? []) {
    const key = settlementGroupKey(tx.id);
    claimants.set(key, (claimants.get(key) ?? new Set()).add(JSON.stringify([deal.jobId, tx.phaseIndex])));
  }
  scoped = scoped.filter((deal) => !(deal.settlementTxIds ?? []).some((tx) => claimants.get(settlementGroupKey(tx.id))!.size > 1));
  const completed = scoped.filter((deal) => deal.sellerOutcome === "completed").length;
  const bundleRefs = scoped.filter((deal) => deal.bundleContentHash).map((deal) => ({
    kind: "dacs-5-bundle" as const,
    id: deal.jobId,
    contentHash: deal.bundleContentHash!,
    anchor: {
      kind: "storage-program" as const,
      locator: deal.anchoredByRole === "buyer" ? deal.buyerBundleRef : deal.sellerBundleRef ?? deal.buyerBundleRef,
    },
  })).sort((a, b) => byteOrder(a.contentHash, b.contentHash));
  const completedWithPrice = scoped.filter((deal) => deal.sellerOutcome === "completed" && deal.agreementPrice);
  const amounts = new Map<string, string[]>();
  for (const deal of completedWithPrice) {
    const price = deal.agreementPrice!;
    amounts.set(price.currency, [...(amounts.get(price.currency) ?? []), price.amount]);
  }
  // A malformed member must not fabricate a zero total or a matching count.
  // Omit the affected currency entirely; current verified price terms never
  // reach this branch, but the fail-closed behavior protects future callers.
  const currencyTotals = [...amounts].flatMap(([currency, values]) => {
    const amount = sumDecimals(values);
    return amount === null ? [] : [{ currency, amount, count: values.length }];
  }).sort((a, b) => byteOrder(a.currency, b.currency));
  const observedTransactionalVolume = currencyTotals.map(({ currency, amount }) => ({ currency, amount }));
  const transactionCountByCurrency = currencyTotals.map(({ currency, count }) => ({ currency, count }));
  return {
    completed,
    bundleCount: scoped.length,
    totalAgreements: scoped.length,
    ...UNAVAILABLE_TESTNET_METRICS,
    ...OBSERVED_REPUTATION_COUNTS,
    observedOutcomesLabel: observedOutcomesLabel(scoped.length),
    observedTransactionalVolume,
    transactionCountByCurrency,
    bundleRefs,
    windowStart,
    windowEnd,
    windowingBasis: useAnchorTimestamps ? "sr2-anchor-timestamp" : "finalisedAt",
  };
}

/**
 * Collision grouping key. SB-1 renders hashes as lower-case hex without `0x`,
 * so spelling variants of one hash group together; grouping more never lets a
 * collision go uncounted.
 */
function settlementGroupKey(id: string): string {
  return id.trim().replace(/(?:0x)?([0-9a-f]{64})/gi, (_match, hash: string) => hash.toLowerCase());
}

/** Exact non-negative decimal addition without binary floating-point drift. */
function sumDecimals(values: string[]): string | null {
  let scale = 0;
  const parsed = values.map((value) => {
    if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
    const [whole, fraction = ""] = value.split(".");
    scale = Math.max(scale, fraction.length);
    return { whole, fraction };
  });
  if (parsed.some((value) => !value)) return null;
  const total = parsed.reduce((sum, value) => sum + BigInt(value!.whole + value!.fraction.padEnd(scale, "0")), 0n);
  const digits = total.toString().padStart(scale + 1, "0");
  if (!scale) return digits;
  const result = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, "");
  return result || "0";
}
