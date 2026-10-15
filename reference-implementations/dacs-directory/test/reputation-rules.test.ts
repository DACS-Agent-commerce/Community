import assert from "node:assert/strict";
import test from "node:test";
import { deriveSellerReputation, flipOutcome, isNeutralCancellation } from "../src/catalog/reputation.js";
import type { DealRecord } from "../src/catalog/types.js";

// DACS-5 §10.5 derivation: which deals count, on which time basis, and what the reported
// rates, ratings, volume and bundle references are.
const SELLER = "did:demos:agent:seller";
let next = 0;
function deal(change: Partial<DealRecord> = {}): DealRecord {
  const n = ++next;
  return {
    jobId: `job-${n}`, rail: "pay-dem", buyerBundleRef: `stor-b${n}`, sellerBundleRef: `stor-s${n}`, owners: { buyer: "did:demos:agent:buyer", seller: SELLER },
    signatureVerified: true, refsVerified: true, reputationEligible: true, sellerOutcome: "completed", finalisedAt: 10, verifiedAt: 10,
    bundleContentHash: n.toString(16).padStart(64, "0"), anchoredByRole: "seller", ...change,
  };
}

test("only verified, eligible deals with a current outcome are scored", () => {
  const scored = (deals: DealRecord[]) => deriveSellerReputation(deals, 0, 100).bundleCount;
  assert.equal(scored([deal()]), 1);
  assert.equal(scored([deal({ refsVerified: false })]), 0);
  assert.equal(scored([deal({ reputationEligible: false })]), 0);
  assert.equal(scored([deal({ sellerOutcome: "won" })]), 0);
  assert.equal(scored([deal({ sellerOutcome: undefined })]), 0);
  for (const outcome of ["completed", "failed-perm", "failed-counterparty", "failed-substrate", "aborted-by-self", "aborted-by-other"]) {
    assert.equal(scored([deal({ sellerOutcome: outcome })]), 1, outcome);
  }
});

test("the window uses SR-2 anchor time only when every scored deal has one, with inclusive bounds", () => {
  const anchored = deriveSellerReputation([deal({ anchorTimestamp: 50, finalisedAt: 500 }), deal({ anchorTimestamp: 60, finalisedAt: 1 })], 50, 60);
  assert.equal(anchored.windowingBasis, "sr2-anchor-timestamp");
  assert.equal(anchored.bundleCount, 2);
  const mixed = deriveSellerReputation([deal({ anchorTimestamp: 50, finalisedAt: 5 }), deal({ finalisedAt: 6 })], 5, 6);
  assert.equal(mixed.windowingBasis, "finalisedAt");
  assert.equal(mixed.bundleCount, 2);
  assert.equal(deriveSellerReputation([deal({ finalisedAt: 4 }), deal({ finalisedAt: 7 })], 5, 6).bundleCount, 0);
  assert.equal(deriveSellerReputation([deal({ finalisedAt: undefined })], 0, 100).bundleCount, 0);
  // A scored deal outside the window does not decide the basis for the others.
  assert.equal(deriveSellerReputation([deal({ refsVerified: false, finalisedAt: 1 }), deal({ anchorTimestamp: 9 })], 0, 100).windowingBasis, "sr2-anchor-timestamp");
});

test("SB-2: a reused settlement id counts once, for the earliest observation, and its other deals drop out", () => {
  const tx = (id: string, observedAt: number, evidenceHash = "a".repeat(64)) => ({ id, observedAt, phaseIndex: 2, evidenceHash });
  const later = deal({ jobId: "a-later", settlementTxIds: [tx("t", 20)] });
  const earlier = deal({ jobId: "z-earlier", settlementTxIds: [tx("t", 10)] });
  const kept = (deals: DealRecord[]) => (deriveSellerReputation(deals, 0, 100).bundleRefs ?? []).map((ref) => ref.id).sort();
  assert.deepEqual(kept([later, earlier]), ["z-earlier"]);
  assert.deepEqual(kept([earlier, later]), ["z-earlier"]);
  // A deal citing a second, unshared settlement still drops out when one of its ids belongs elsewhere.
  assert.deepEqual(kept([earlier, deal({ jobId: "two-txs", settlementTxIds: [tx("u", 5), tx("t", 30)] })]), ["z-earlier"]);
  assert.deepEqual(kept([deal({ jobId: "own", settlementTxIds: [tx("v", 1)] }), earlier]), ["own", "z-earlier"]);
});

test("rates: substrate failures and policy cancellations are neutral, and counterparty faults leave the blame denominator", () => {
  const reputation = deriveSellerReputation([
    deal(), deal(), deal({ sellerOutcome: "failed-perm" }), deal({ sellerOutcome: "failed-counterparty" }), deal({ sellerOutcome: "aborted-by-other" }),
    deal({ sellerOutcome: "failed-substrate" }), deal({ sellerOutcome: "aborted-by-self", cancellationNeutral: true }),
    deal({ sellerOutcome: "aborted-by-other", cancellationNeutral: true }),
  ], 0, 100);
  assert.equal(reputation.completed, 2);
  assert.equal(reputation.totalAgreements, 8);
  assert.equal(reputation.completionRate, 2 / 5);
  assert.equal(reputation.counterpartyFaultRate, 2 / 5);
  assert.equal(reputation.counterpartyAdjustedCompletionRate, 2 / 3);
  const neutralOnly = deriveSellerReputation([deal({ sellerOutcome: "failed-substrate" })], 0, 100);
  assert.deepEqual([neutralOnly.completionRate, neutralOnly.counterpartyFaultRate, neutralOnly.counterpartyAdjustedCompletionRate], [null, null, null]);
  const blameless = deriveSellerReputation([deal({ sellerOutcome: "failed-counterparty" })], 0, 100);
  assert.deepEqual([blameless.completionRate, blameless.counterpartyAdjustedCompletionRate], [0, null]);
  assert.equal(deriveSellerReputation([], 0, 100).averageBuyerRating, null);
});

test("bundle references name the authoritative copy and are ordered by content hash bytes", () => {
  const refs = deriveSellerReputation([
    deal({ jobId: "seller-copy", bundleContentHash: "b".repeat(64), anchoredByRole: "seller", sellerBundleRef: "stor-seller", buyerBundleRef: "stor-buyer" }),
    deal({ jobId: "buyer-copy", bundleContentHash: "a".repeat(64), anchoredByRole: "buyer", sellerBundleRef: "stor-seller-2", buyerBundleRef: "stor-buyer-2" }),
    deal({ jobId: "no-seller-copy", bundleContentHash: "c".repeat(64), anchoredByRole: "seller", sellerBundleRef: undefined, buyerBundleRef: "stor-buyer-3" }),
    deal({ jobId: "unhashed", bundleContentHash: undefined }),
  ], 0, 100).bundleRefs ?? [];
  assert.deepEqual(refs.map((ref) => [ref.id, ref.anchor.locator]), [["buyer-copy", "stor-buyer-2"], ["seller-copy", "stor-seller"], ["no-seller-copy", "stor-buyer-3"]]);
  assert.ok(refs.every((ref) => ref.kind === "dacs-5-bundle" && ref.anchor.kind === "storage-program"));
});

test("seller ratings: one per rater, job and role, the latest wins, and self-ratings and others' targets are ignored", () => {
  const rating = (rater: string, value: number, ratedAt: number, change: Record<string, unknown> = {}) =>
    ({ rater, target: SELLER, targetRole: "seller" as const, value, ratedAt, contentHash: "1".repeat(64), ...change });
  const average = (ratings: NonNullable<DealRecord["ratings"]>) => deriveSellerReputation([deal({ ratings })], 0, 100).averageSellerRating;
  assert.equal(average([rating("buyer", 4, 1)]), 4);
  assert.equal(average([rating("buyer", 1, 1), rating("BUYER", 5, 2)]), 5, "the later rating by the same rater replaces the earlier");
  assert.equal(average([rating("buyer", 5, 2), rating("buyer", 1, 1)]), 5);
  assert.equal(average([rating("buyer", 1, 2, { contentHash: "1".repeat(64) }), rating("buyer", 3, 2, { contentHash: "2".repeat(64) })]), 3, "a tie keeps the higher content hash");
  assert.equal(average([rating("buyer", 2, 1), rating("other", 4, 1)]), 3);
  assert.equal(average([rating(SELLER, 5, 1)]), null, "a self-rating");
  assert.equal(average([rating("buyer", 5, 1, { target: "did:demos:agent:else" })]), null, "a rating of someone else");
  assert.equal(average([rating("buyer", 5, 1, { targetRole: "buyer" })]), null, "a buyer-role rating");
  assert.equal(average([rating("buyer", 5, 1, { target: SELLER.toUpperCase() })]), 5, "claims compare case-insensitively");
});

test("observed volume sums completed deals' agreed prices exactly, per currency in byte order", () => {
  const priced = (amount: string, currency: string, sellerOutcome = "completed") => deal({ agreementPrice: { amount, currency }, sellerOutcome });
  const reputation = deriveSellerReputation([
    priced("0.1", "USDC"), priced("0.2", "USDC"), priced("2", "DEM"), priced("3", "DEM"), priced("9", "DEM", "failed-perm"),
    priced("1.25", "eur"), deal({ agreementPrice: undefined }),
  ], 0, 100);
  assert.deepEqual(reputation.observedTransactionalVolume, [{ currency: "DEM", amount: "5" }, { currency: "USDC", amount: "0.3" }, { currency: "eur", amount: "1.25" }]);
  assert.deepEqual(reputation.transactionCountByCurrency, [{ currency: "DEM", count: 2 }, { currency: "USDC", count: 2 }, { currency: "eur", count: 1 }]);
  assert.deepEqual(deriveSellerReputation([priced("0.5", "DEM"), priced("0.5", "DEM")], 0, 100).observedTransactionalVolume, [{ currency: "DEM", amount: "1" }]);
  assert.deepEqual(deriveSellerReputation([priced("0.05", "DEM"), priced("0.05", "DEM")], 0, 100).observedTransactionalVolume, [{ currency: "DEM", amount: "0.1" }]);
  assert.deepEqual(deriveSellerReputation([priced("0", "DEM")], 0, 100).observedTransactionalVolume, [{ currency: "DEM", amount: "0" }]);
  assert.deepEqual(deriveSellerReputation([priced("0.0", "DEM")], 0, 100).observedTransactionalVolume, [{ currency: "DEM", amount: "0" }]);
  // A malformed amount omits its currency rather than inventing a total.
  assert.deepEqual(deriveSellerReputation([priced("1", "DEM"), priced("1e3", "DEM"), priced("2", "USD")], 0, 100).observedTransactionalVolume, [{ currency: "USD", amount: "2" }]);
});

test("ST-10: a cancellation is neutral only for a pre-commit abort under a signed pre-commit policy", () => {
  const ok = { claimedPolicy: "pre-commit" }; const terms = { cancellationPolicy: "pre-commit" };
  assert.equal(isNeutralCancellation("aborted-by-self", ok, terms, []), true);
  assert.equal(isNeutralCancellation("aborted-by-other", ok, terms, [{ kind: "negotiate-fixed-price", outcome: "ok" }]), true);
  assert.equal(isNeutralCancellation("aborted-by-self", ok, terms, [{ kind: "commit-agreement", outcome: "fail" }]), true);
  for (const [name, args] of Object.entries({
    "a completed session": ["completed", ok, terms, []],
    "a failed session": ["failed-perm", ok, terms, []],
    "no marker": ["aborted-by-self", undefined, terms, []],
    "a marker list": ["aborted-by-self", [ok], terms, []],
    "a with-fee claim": ["aborted-by-self", { claimedPolicy: "with-fee" }, terms, []],
    "no listing terms": ["aborted-by-self", ok, undefined, []],
    "terms as a list": ["aborted-by-self", ok, [terms], []],
    "a none policy": ["aborted-by-self", ok, { cancellationPolicy: "none" }, []],
    "after commit-agreement": ["aborted-by-self", ok, terms, [{ kind: "commit-agreement", outcome: "ok" }]],
    "after commit-payee-bound-agreement": ["aborted-by-other", ok, terms, [null, { kind: "commit-payee-bound-agreement", outcome: "ok" }]],
  } as Record<string, [string, unknown, unknown, unknown]>)) assert.equal(isNeutralCancellation(...args), false, name);
  assert.deepEqual(["aborted-by-self", "aborted-by-other", "failed-perm", "failed-counterparty", "completed", undefined].map(flipOutcome),
    ["aborted-by-other", "aborted-by-self", "failed-counterparty", "failed-perm", "completed", undefined]);
});

test("further derivation rules: the empty basis, SB-2 ties on equal hashes, and rating recency before hash", () => {
  assert.equal(deriveSellerReputation([], 0, 100).windowingBasis, "finalisedAt");
  const tx = (observedAt: number, evidenceHash: string) => [{ id: "shared", observedAt, phaseIndex: 2, evidenceHash }];
  const kept = (deals: DealRecord[]) => (deriveSellerReputation(deals, 0, 100).bundleRefs ?? []).map((ref) => ref.id);
  const a = deal({ jobId: "a", settlementTxIds: tx(10, "5".repeat(64)) });
  const z = deal({ jobId: "z", settlementTxIds: tx(10, "5".repeat(64)) });
  assert.deepEqual(kept([a, z]), ["a"]);
  assert.deepEqual(kept([z, a]), ["a"]);
  const rating = (value: number, ratedAt: number, contentHash: string) => ({ rater: "buyer", target: SELLER, targetRole: "seller" as const, value, ratedAt, contentHash });
  const average = (ratings: NonNullable<DealRecord["ratings"]>) => deriveSellerReputation([deal({ ratings })], 0, 100).averageSellerRating;
  assert.equal(average([rating(2, 5, "9".repeat(64)), rating(4, 6, "1".repeat(64))]), 4, "the newer rating wins over a higher hash");
  assert.equal(average([rating(4, 6, "1".repeat(64)), rating(2, 5, "9".repeat(64))]), 4);
  assert.equal(average([rating(3, 6, "9".repeat(64)), rating(5, 6, "1".repeat(64))]), 3, "an equal time keeps the higher hash in either order");
});
