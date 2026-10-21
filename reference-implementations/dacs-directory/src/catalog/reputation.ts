import { dealSessionKey } from "./bundleSignerPolicy.js";
import { averageRange, rateRange, type RateRange } from "./rateRange.js";
import { admitSettlement, type SettlementClaim } from "./settlementKey.js";
import type { DealRecord, ReputationHint, SellerRecord } from "./types.js";

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

/**
 * DACS-5 ST-10: a cancellation marker is established only when the signed listing permits
 * pre-commit cancellation and the session ended pre-commit: no agreementRef, and every phase it
 * recorded is a Vet or Negotiate phase (vet-pending or negotiate-pending). A session that reached
 * a commitment phase at all, whatever its outcome, is not pre-commit.
 */
export function isNeutralCancellation(
  sellerOutcome: string | undefined,
  cancellation: unknown,
  listingTerms: unknown,
  phaseSummary: unknown,
  agreementRef: unknown,
): boolean {
  const marker = cancellation && typeof cancellation === "object" && !Array.isArray(cancellation)
    ? cancellation as Record<string, unknown> : undefined;
  const terms = listingTerms && typeof listingTerms === "object" && !Array.isArray(listingTerms)
    ? listingTerms as Record<string, unknown> : undefined;
  const phases = Array.isArray(phaseSummary) ? phaseSummary.filter((phase): phase is Record<string, unknown> =>
    Boolean(phase && typeof phase === "object" && !Array.isArray(phase))) : [];
  const preCommit = Array.isArray(phaseSummary) && phases.length === phaseSummary.length &&
    phases.every((phase) => typeof phase.kind === "string" && /^(?:vet|negotiate)-/.test(phase.kind));
  return (sellerOutcome === "aborted-by-self" || sellerOutcome === "aborted-by-other") &&
    marker?.claimedPolicy === "pre-commit" && terms?.cancellationPolicy === "pre-commit" &&
    agreementRef === undefined && preCommit;
}

/** Admit the consumer's complete evidence set before seller, category or window filtering. */
export function settlementEligibleDeals(records: DealRecord[]): DealRecord[] {
  // Only a settlement this deployment confirmed on the node may claim, or reject, an id: an asserted
  // one would let any producer evict another seller's verified completion. A deal citing a settlement
  // without that stamp (as an earlier release persisted it) is not admitted until it is verified again.
  const deals = records.filter((deal) => deal.refsVerified && deal.reputationEligible && !deal.settlementRejected &&
    CURRENT_OUTCOMES.has(deal.sellerOutcome ?? "") && (deal.settlementTxIds ?? []).every((tx) => tx.nodeVerified === true));
  // SB-2: one settlement-tx-id counts under one (jobId, phaseIndex) of one session only; a jobId is
  // unique only per producer, so another buyer's session on the same jobId is a second binding.
  // Claims are admitted in the winning order, earliest evidence observation first, then the lower
  // evidence hash, then the jobId and session so the choice is deterministic; a session holding any
  // rejected claim is not counted.
  const claims = deals.flatMap((deal) => (deal.settlementTxIds ?? []).map((tx) => ({ deal, tx, session: dealSessionKey(deal) })))
    .sort((a, b) => a.tx.observedAt - b.tx.observedAt || byteOrder(a.tx.evidenceHash ?? "", b.tx.evidenceHash ?? "") ||
      byteOrder(a.deal.jobId, b.deal.jobId) || byteOrder(a.session, b.session) || a.tx.phaseIndex - b.tx.phaseIndex);
  const ledger = new Map<string, Omit<SettlementClaim, "id">>();
  const rejected = new Set<DealRecord>();
  for (const { deal, tx, session } of claims) {
    if (admitSettlement(ledger, { id: tx.id, jobId: deal.jobId, phaseIndex: tx.phaseIndex, session }) === "reject") rejected.add(deal);
  }
  return deals.filter((deal) => !rejected.has(deal));
}

/** Final catalog pass: one ledger for every seller, then recompute every published metric. */
export function reconcileCatalogReputation(sellers: SellerRecord[], now: number): void {
  // Reconsider previous losers when a winner disappears or its evidence changes.
  for (const seller of sellers) for (const deal of seller.deals) delete deal.settlementRejected;
  const admitted = new Set(settlementEligibleDeals(sellers.flatMap((seller) => seller.deals)));
  for (const seller of sellers) {
    for (const deal of seller.deals) {
      if (deal.reputationEligible && !admitted.has(deal)) deal.settlementRejected = true;
    }
    seller.reputation = deriveSellerReputation(seller.deals, 0, now);
    for (const listing of seller.listings) {
      listing.reputationHint = categoryReputationHint(listing.offering.category, seller.deals, 0, now, now);
    }
  }
}

/** DACS-5 RatingRecord.value: an integer from 1 to 5 (evidenceGraph.ts shapeOk). */
const RATING_MIN = 1;
const RATING_MAX = 5;
const COUNTERPARTY_FAULT = new Set(["failed-counterparty", "aborted-by-other"]);
const OWN_FAULT = new Set(["failed-perm", "aborted-by-self"]);
type Rate = "completionRate" | "counterpartyAdjustedCompletionRate" | "counterpartyFaultRate";
/** What one session with this outcome adds to each rate: to the numerator and the denominator, to the denominator
 * only, or nothing. Neutral sessions add nothing; ST-10 and orchestrator neutrality are not known for an undecided
 * session, so it may add as a party fault, which only widens its range. */
const CONTRIBUTION: Record<Rate, (outcome: string) => "both" | "denominator" | null> = {
  completionRate: (outcome) => outcome === "completed" ? "both" : OWN_FAULT.has(outcome) || COUNTERPARTY_FAULT.has(outcome) ? "denominator" : null,
  counterpartyAdjustedCompletionRate: (outcome) => outcome === "completed" ? "both" : OWN_FAULT.has(outcome) ? "denominator" : null,
  counterpartyFaultRate: (outcome) => COUNTERPARTY_FAULT.has(outcome) ? "both" : outcome === "completed" || OWN_FAULT.has(outcome) ? "denominator" : null,
};

/**
 * DACS-5 §10.5.1 at run time: the sessions this pass could not decide, one per session, with the outcomes their
 * copies claim. A session any record of which was decided is not undecided. A session is in the window when either
 * of its times is, so a basis the decided set chooses can only narrow what it could add.
 */
function undecidedSessions(deals: DealRecord[], windowStart: number, windowEnd: number) {
  const sessions = new Map<string, { deal: DealRecord; outcomes: Set<string>; ratingsAtMost: number }>();
  if (!deals.some((deal) => deal.undecided)) return sessions;
  // A stored record without owners names no session; an undecided one then stands alone, which only widens a range.
  const sessionKey = (deal: DealRecord) => deal.owners && typeof deal.owners === "object" ? dealSessionKey(deal)
    : `${String(deal.jobId)}\n${String(deal.buyerBundleRef)}`;
  const decided = new Set(deals.filter((deal) => deal.refsVerified).map(sessionKey));
  const inWindow = (time: number | undefined) => typeof time === "number" && time >= windowStart && time <= windowEnd;
  for (const deal of deals) {
    const key = sessionKey(deal);
    if (!deal.undecided || decided.has(key) || !(inWindow(deal.anchorTimestamp) || inWindow(deal.finalisedAt))) continue;
    // An outcome the copies do not state, or one this derivation does not know, could be any; a rating count that
    // is not a count could be one per party besides the seller (buyer and orchestrator).
    const claimed = deal.undecided.sellerOutcomes.filter((outcome) => CURRENT_OUTCOMES.has(outcome));
    const outcomes = claimed.length > 0 && claimed.length === deal.undecided.sellerOutcomes.length ? claimed : [...CURRENT_OUTCOMES];
    const ratingsAtMost = Number.isSafeInteger(deal.undecided.ratingsAtMost) && deal.undecided.ratingsAtMost >= 0 ? deal.undecided.ratingsAtMost : 2;
    const session = sessions.get(key) ?? { deal, outcomes: new Set<string>(), ratingsAtMost: 0 };
    for (const outcome of outcomes) session.outcomes.add(outcome);
    session.ratingsAtMost = Math.max(session.ratingsAtMost, ratingsAtMost);
    sessions.set(key, session);
  }
  return sessions;
}

/**
 * DACS-5 scalar derivation over already signature/reference-verified,
 * seller-perspective records. Reconciliation and divergence exclusion happen
 * before this function; unresolved ratings/volume intentionally remain absent.
 * `inScope` narrows the scored deals after the SB-2 ledger, as a ReputationHint's category does.
 *
 * Undecided sessions (DealRecord.undecided) are in no count, and each rate they could change is null with its
 * range (rateRange.ts), never a figure over a partial denominator (DACS-5 §10.5.1: exclusion neither helps nor
 * harms).
 */
export function deriveSellerReputation(
  deals: DealRecord[],
  windowStart = 0,
  windowEnd = Date.now(),
  inScope: (deal: DealRecord) => boolean = () => true,
): SellerRecord["reputation"] {
  const eligible = settlementEligibleDeals(deals).filter(inScope);
  // A determinism receipt declares one timestamp basis for its entire input
  // set. Use SR-2 anchor time only when it is available for every eligible
  // record; otherwise fall back to finalisedAt uniformly and exclude records
  // that cannot be evaluated on that honest basis.
  const useAnchorTimestamps = eligible.length > 0 &&
    eligible.every((deal) => typeof deal.anchorTimestamp === "number");
  const timestampOf = (deal: DealRecord) => useAnchorTimestamps
    ? deal.anchorTimestamp
    : deal.finalisedAt;
  const scoped = eligible.filter((deal) => {
    const timestamp = timestampOf(deal);
    return typeof timestamp === "number" && timestamp >= windowStart && timestamp <= windowEnd;
  });
  const completed = scoped.filter((deal) => deal.sellerOutcome === "completed").length;
  const neutral = scoped.filter((deal) => deal.sellerOutcome === "failed-substrate" || deal.cancellationNeutral || deal.orchestratorFaultNeutral).length;
  const counterpartyFault = scoped.filter((deal) => !deal.cancellationNeutral && !deal.orchestratorFaultNeutral &&
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
  })).sort((a, b) => byteOrder(a.contentHash, b.contentHash));
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
  // A malformed member must not fabricate a zero total or a matching count.
  // Omit the affected currency entirely; current verified price terms never
  // reach this branch, but the fail-closed behavior protects future callers.
  const currencyTotals = [...amounts].flatMap(([currency, values]) => {
    const amount = sumDecimals(values);
    return amount === null ? [] : [{ currency, amount, count: values.length }];
  }).sort((a, b) => byteOrder(a.currency, b.currency));
  const observedTransactionalVolume = currencyTotals.map(({ currency, amount }) => ({ currency, amount }));
  const transactionCountByCurrency = currencyTotals.map(({ currency, count }) => ({ currency, count }));
  const undecided = [...undecidedSessions(deals, windowStart, windowEnd).values()].filter(({ deal }) => inScope(deal));
  const decidedRates: Record<Rate, [number, number]> = {
    completionRate: [completed, partyFaultDenominator],
    counterpartyAdjustedCompletionRate: [completed, blameDenominator],
    counterpartyFaultRate: [counterpartyFault, partyFaultDenominator],
  };
  const rates = {} as Record<Rate, number | null>;
  const ranges = {} as Record<`${Rate}Range`, RateRange>;
  for (const [rate, [numerator, denominator]] of Object.entries(decidedRates) as Array<[Rate, [number, number]]>) {
    const could = (contribution: "both" | "denominator") => undecided.filter(({ outcomes }) =>
      [...outcomes].some((outcome) => CONTRIBUTION[rate](outcome) === contribution)).length;
    const both = could("both"), denominatorOnly = could("denominator");
    const range = rateRange(numerator, denominator, both, denominatorOnly);
    // A point is published only when no way of deciding the undecided sessions can change it.
    const settled = (both === 0 && denominatorOnly === 0) || (denominator > 0 && range.low === range.high);
    rates[rate] = settled && denominator > 0 ? numerator / denominator : null;
    ranges[`${rate}Range`] = range;
  }
  // Ratings track outcomes, so the ratings an undecided session could add move the average the same way.
  const ratingSum = sellerRatings.reduce((a, b) => a + b, 0);
  const ratingsAtMost = undecided.reduce((sum, session) => sum + session.ratingsAtMost, 0);
  const averageSellerRatingRange = averageRange(ratingSum, sellerRatings.length, ratingsAtMost, RATING_MIN, RATING_MAX);
  return {
    completed,
    bundleCount: scoped.length,
    totalAgreements: scoped.length,
    ...rates,
    // This catalog record is seller-scoped. Buyer-side sessions are not part
    // of its input set, so surfacing a buyer rating here would invent signal.
    averageBuyerRating: null,
    averageSellerRating: sellerRatings.length && ratingsAtMost === 0 ? ratingSum / sellerRatings.length : null,
    observedTransactionalVolume,
    transactionCountByCurrency,
    bundleRefs,
    windowStart,
    windowEnd,
    windowingBasis: useAnchorTimestamps ? "sr2-anchor-timestamp" : "finalisedAt",
    ...(undecided.length > 0 ? { undecidedSessions: undecided.length, ...ranges, averageSellerRatingRange } : {}),
  };
}

/**
 * DACS-1 §6.3.6 ReputationHint for one listing: categoryScope is the listing's own category, and
 * the metrics come from the §10.5.1 derivation over the deals in that scope only (the category and
 * its sub-categories), so SB-2, the window and the neutral outcomes apply exactly as for the seller.
 * DACS-5 §10.5.4 scopes by the category of the listing a session's agreement pins (DealRecord.agreementCategory)
 * and excludes a session without one, "not treated as matching any category": a pre-commit session, and a
 * session, decided or not, whose agreement or listing this pass could not read. Those count for the seller only.
 */
export function categoryReputationHint(
  category: string,
  deals: DealRecord[],
  windowStart: number,
  windowEnd: number,
  computedAt: number,
): ReputationHint {
  const scoped = deriveSellerReputation(deals, windowStart, windowEnd, (deal) =>
    deal.agreementCategory === category || deal.agreementCategory?.startsWith(`${category}.`) === true);
  return {
    categoryScope: category,
    completionRate: scoped.completionRate,
    averageSellerRating: scoped.averageSellerRating ?? null,
    bundleCount: scoped.bundleCount ?? 0,
    windowStart,
    windowEnd,
    computedAt,
    ...(scoped.undecidedSessions ? { undecidedSessions: scoped.undecidedSessions, completionRateRange: scoped.completionRateRange,
      averageSellerRatingRange: scoped.averageSellerRatingRange } : {}),
  };
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
