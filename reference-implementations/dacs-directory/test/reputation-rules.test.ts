import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { categoryReputationHint, deriveSellerReputation, flipOutcome, isNeutralCancellation, reconcileCatalogReputation, settlementEligibleDeals } from "../src/catalog/reputation.js";
import { admitSettlement } from "../src/catalog/settlementKey.js";
import { rateRange } from "../src/catalog/rateRange.js";
import type { DealRecord, SellerRecord } from "../src/catalog/types.js";

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
  const tx = (id: string, observedAt: number, evidenceHash = "a".repeat(64)) => ({ id, observedAt, phaseIndex: 2, evidenceHash, nodeVerified: true });
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
  assert.equal(isNeutralCancellation("aborted-by-self", ok, terms, [], undefined), true);
  assert.equal(isNeutralCancellation("aborted-by-other", ok, terms, [{ kind: "negotiate-fixed-price", outcome: "ok" }], undefined), true);
  assert.equal(isNeutralCancellation("aborted-by-self", ok, terms, [{ kind: "vet-credentials", outcome: "ok" }, { kind: "negotiate-rfq", outcome: "fail" }], undefined), true);
  const agreementRef = { anchor: { kind: "storage-program", locator: `stor-${"1".repeat(40)}` }, contentHash: "1".repeat(64) };
  for (const [name, args] of Object.entries({
    "a completed session": ["completed", ok, terms, [], undefined],
    "a failed session": ["failed-perm", ok, terms, [], undefined],
    "no marker": ["aborted-by-self", undefined, terms, [], undefined],
    "a marker list": ["aborted-by-self", [ok], terms, [], undefined],
    "a with-fee claim": ["aborted-by-self", { claimedPolicy: "with-fee" }, terms, [], undefined],
    "no listing terms": ["aborted-by-self", ok, undefined, [], undefined],
    "terms as a list": ["aborted-by-self", ok, [terms], [], undefined],
    "a none policy": ["aborted-by-self", ok, { cancellationPolicy: "none" }, [], undefined],
    "after commit-agreement": ["aborted-by-self", ok, terms, [{ kind: "commit-agreement", outcome: "ok" }], undefined],
    "after commit-payee-bound-agreement": ["aborted-by-other", ok, terms, [null, { kind: "commit-payee-bound-agreement", outcome: "ok" }], undefined],
    // The session reached its commitment phase, so it was no longer vet- or negotiate-pending.
    "a failed commit phase": ["aborted-by-self", ok, terms, [{ kind: "commit-agreement", outcome: "fail" }], undefined],
    "a settle phase without a commit entry": ["aborted-by-self", ok, terms, [{ kind: "pay-dem", outcome: "fail" }], undefined],
    "a bundle carrying an agreementRef": ["aborted-by-self", ok, terms, [{ kind: "negotiate-fixed-price", outcome: "ok" }], agreementRef],
    "a phaseSummary that is not a list": ["aborted-by-self", ok, terms, {}, undefined],
  } as Record<string, [string, unknown, unknown, unknown, unknown]>)) assert.equal(isNeutralCancellation(...args), false, name);
  assert.deepEqual(["aborted-by-self", "aborted-by-other", "failed-perm", "failed-counterparty", "completed", undefined].map(flipOutcome),
    ["aborted-by-other", "aborted-by-self", "failed-counterparty", "failed-perm", "completed", undefined]);
});

test("DACS-1 §6.3.6 ReputationHint: the listing's category scopes the metrics, sub-categories included, others never", () => {
  const rating = (value: number) => [{ rater: "buyer", target: SELLER, targetRole: "seller" as const, value, ratedAt: 5, contentHash: "1".repeat(64) }];
  const deals = [
    deal({ category: "data.finance", ratings: rating(5) }),
    deal({ category: "data.finance.equities", sellerOutcome: "failed-perm", ratings: rating(3) }),
    deal({ category: "data.finance", sellerOutcome: "failed-substrate" }),
    // Other categories, including a sibling that only shares a string prefix.
    deal({ category: "data.weather", sellerOutcome: "failed-perm", ratings: rating(1) }),
    deal({ category: "data.financial", sellerOutcome: "failed-perm", ratings: rating(1) }),
    deal({ category: undefined, sellerOutcome: "failed-perm" }),
  ];
  const hint = categoryReputationHint("data.finance", deals, 0, 100, 7);
  assert.deepEqual(hint, {
    categoryScope: "data.finance", completionRate: 1 / 2, averageSellerRating: 4, bundleCount: 3, windowStart: 0, windowEnd: 100, computedAt: 7,
  });
  assert.equal(categoryReputationHint("data", deals, 0, 100, 7).bundleCount, 5, "a parent category scopes every sub-category");
  assert.deepEqual(categoryReputationHint("legal", deals, 0, 100, 7), {
    categoryScope: "legal", completionRate: null, averageSellerRating: null, bundleCount: 0, windowStart: 0, windowEnd: 100, computedAt: 7,
  });
  // The hint applies SB-2 and the window exactly as the seller derivation does.
  const tx = [{ id: "shared", observedAt: 1, phaseIndex: 2, evidenceHash: "a".repeat(64), nodeVerified: true }];
  const reused = [deal({ category: "data.finance", settlementTxIds: tx }), deal({ category: "data.finance", settlementTxIds: [{ ...tx[0], observedAt: 2 }] })];
  assert.equal(categoryReputationHint("data.finance", reused, 0, 100, 7).bundleCount, 1);
  assert.equal(categoryReputationHint("data.finance", [deal({ category: "data.finance", finalisedAt: 500 })], 0, 100, 7).bundleCount, 0);
});

test("further derivation rules: the empty basis, SB-2 ties on equal hashes, and rating recency before hash", () => {
  assert.equal(deriveSellerReputation([], 0, 100).windowingBasis, "finalisedAt");
  const tx = (observedAt: number, evidenceHash: string) => [{ id: "shared", observedAt, phaseIndex: 2, evidenceHash, nodeVerified: true }];
  const kept = (deals: DealRecord[]) => (deriveSellerReputation(deals, 0, 100).bundleRefs ?? []).map((ref) => ref.id);
  const a = deal({ jobId: "a", settlementTxIds: tx(10, "5".repeat(64)) });
  const z = deal({ jobId: "z", settlementTxIds: tx(10, "5".repeat(64)) });
  assert.deepEqual(kept([a, z]), ["a"]);
  assert.deepEqual(kept([z, a]), ["a"]);
  // DACS-4 SB-2: at an equal observedAt the lower evidence hash wins, before the jobId is consulted.
  const higherHash = deal({ jobId: "a-job", settlementTxIds: tx(10, "9".repeat(64)) });
  const lowerHash = deal({ jobId: "z-job", settlementTxIds: tx(10, "1".repeat(64)) });
  assert.deepEqual(kept([higherHash, lowerHash]), ["z-job"]);
  assert.deepEqual(kept([lowerHash, higherHash]), ["z-job"]);
  const rating = (value: number, ratedAt: number, contentHash: string) => ({ rater: "buyer", target: SELLER, targetRole: "seller" as const, value, ratedAt, contentHash });
  const average = (ratings: NonNullable<DealRecord["ratings"]>) => deriveSellerReputation([deal({ ratings })], 0, 100).averageSellerRating;
  assert.equal(average([rating(2, 5, "9".repeat(64)), rating(4, 6, "1".repeat(64))]), 4, "the newer rating wins over a higher hash");
  assert.equal(average([rating(4, 6, "1".repeat(64)), rating(2, 5, "9".repeat(64))]), 4);
  assert.equal(average([rating(3, 6, "9".repeat(64)), rating(5, 6, "1".repeat(64))]), 3, "an equal time keeps the higher hash in either order");
});

test("SB-2 rejects one job reusing a settlement under two pipeline indices", () => {
  const reused = deal({ settlementTxIds: [
    { id: "demos:shared", observedAt: 10, phaseIndex: 2, evidenceHash: "a", nodeVerified: true },
    { id: "demos:shared", observedAt: 11, phaseIndex: 3, evidenceHash: "b", nodeVerified: true },
  ] });
  assert.equal(deriveSellerReputation([reused], 0, 100).completed, 0);
  assert.equal(deriveSellerReputation([reused], 0, 100).bundleCount, 0);
});


test("SB-2 records each first claim itself, and one claim cited twice at one phase stays counted", () => {
  const ledger = new Map<string, { jobId: string; phaseIndex: number }>();
  const claim = { id: "demos:self-recorded", jobId: "job", phaseIndex: 2 };
  assert.deepEqual([admitSettlement(ledger, claim), admitSettlement(ledger, claim)], ["count", "already-counted"]);
  assert.equal(admitSettlement(ledger, { ...claim, phaseIndex: 3 }), "reject");
  assert.equal(admitSettlement(ledger, { ...claim, jobId: "other-job" }), "reject");
  const tx = { id: "demos:twice", observedAt: 10, phaseIndex: 2, evidenceHash: "a".repeat(64), nodeVerified: true };
  const twice = deal({ settlementTxIds: [tx, { ...tx }] });
  assert.deepEqual(settlementEligibleDeals([twice]), [twice]);
  assert.equal(deriveSellerReputation([twice], 0, 100).completed, 1);
});

test("SB-2: two sessions on one jobId citing one settlement count it once, for the earlier observation", () => {
  // A jobId is unique only per producer, so another buyer's session may share it; one payment
  // still settles one session (review F-4).
  const tx = (observedAt: number) => [{ id: "demos:one-payment", observedAt, phaseIndex: 2, evidenceHash: "d".repeat(64), nodeVerified: true }];
  const first = deal({ jobId: "shared-job", settlementTxIds: tx(10), agreementPrice: { amount: "2", currency: "DEM" } });
  const second = deal({ jobId: "shared-job", settlementTxIds: tx(11), agreementPrice: { amount: "2", currency: "DEM" },
    owners: { buyer: "did:demos:agent:other-buyer", seller: SELLER } });
  for (const deals of [[first, second], [second, first]]) {
    assert.deepEqual(settlementEligibleDeals(deals), [first]);
    const reputation = deriveSellerReputation(deals, 0, 100);
    assert.equal(reputation.completed, 1);
    assert.deepEqual(reputation.observedTransactionalVolume, [{ currency: "DEM", amount: "2" }]);
  }
  // Equal observation, evidence hash, jobId and phase: the session decides, whatever the input order.
  const tied = deal({ jobId: "shared-job", settlementTxIds: tx(10), owners: { buyer: "did:demos:agent:other-buyer", seller: SELLER } });
  assert.deepEqual(settlementEligibleDeals([first, tied]), settlementEligibleDeals([tied, first]));
  assert.equal(settlementEligibleDeals([first, tied]).length, 1);
});

/** Two sellers whose verified deals cite one settlement id under different jobs; the earlier observation wins. */
function crossSellerCatalog() {
  const sellerRecord = (primaryClaim: string, deals: DealRecord[]): SellerRecord => ({ primaryClaim, displayName: primaryClaim, cci: [], deals,
    listings: [{ offering: { category: "rules.sb2" } } as never], reputation: { completed: 0, totalAgreements: 0, completionRate: null },
    registeredAt: 1, lastIndexedAt: 1 });
  const tx = (observedAt: number) => [{ id: "demos:shared-across-sellers", observedAt, phaseIndex: 2, evidenceHash: "c".repeat(64), nodeVerified: true }];
  const OTHER = "did:demos:agent:other-seller";
  const price = { amount: "2", currency: "DEM" };
  const winner = deal({ jobId: "winner", settlementTxIds: tx(10), agreementPrice: price, category: "rules.sb2" });
  const later = deal({ jobId: "later", settlementTxIds: tx(11), agreementPrice: price, category: "rules.sb2", owners: { buyer: "did:demos:agent:buyer", seller: OTHER } });
  return { sellers: [sellerRecord(SELLER, [winner]), sellerRecord(OTHER, [later])], winner, later };
}

test("SB-2 runs one ledger across every seller in the catalog and reconsiders a loser once the winner is gone", () => {
  const { sellers, later } = crossSellerCatalog();
  // Each seller alone would count its deal; the catalog pass shares the ledger.
  assert.equal(deriveSellerReputation(sellers[1].deals, 0, 100).completed, 1);
  reconcileCatalogReputation(sellers, 100);
  assert.deepEqual(sellers.map((seller) => seller.deals[0].settlementRejected), [undefined, true]);
  assert.deepEqual(sellers.map((seller) => [seller.reputation.completed, seller.reputation.observedTransactionalVolume]),
    [[1, [{ currency: "DEM", amount: "2" }]], [0, []]]);
  assert.equal(sellers[1].listings[0].reputationHint?.bundleCount, 0);
  assert.equal(sellers[0].listings[0].reputationHint?.bundleCount, 1);
  sellers[0].deals = [];
  reconcileCatalogReputation(sellers, 100);
  assert.equal(later.settlementRejected, undefined);
  assert.equal(sellers[1].reputation.completed, 1);
});

test("saving the catalog applies the catalog-wide SB-2 ledger", async (t) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-reputation-rules-"));
  const previous = process.env.DACS_DIRECTORY_DATA;
  process.env.DACS_DIRECTORY_DATA = dataDirectory;
  t.after(() => {
    if (previous === undefined) delete process.env.DACS_DIRECTORY_DATA; else process.env.DACS_DIRECTORY_DATA = previous;
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  const { loadCatalog, saveCatalog } = await import("../src/catalog/store.js");
  const { sellers } = crossSellerCatalog();
  saveCatalog({ catalogVersion: "1", generatedAt: 100, sellers });
  const saved = loadCatalog().sellers;
  assert.deepEqual(saved.map((seller) => [seller.deals[0].settlementRejected, seller.reputation.completed]), [[undefined, 1], [true, 0]]);
  saveCatalog({ catalogVersion: "1", generatedAt: 100, sellers: [{ ...saved[0], deals: [] }, saved[1]] });
  assert.deepEqual(loadCatalog().sellers.map((seller) => seller.reputation.completed), [0, 1]);
});

// Review sweep 10: only a settlement this deployment confirmed on the node takes part in SB-2. A claim
// without that stamp (an unverified citation, or one an earlier release persisted before payments were
// verified) can neither hold nor reject an id, and its deal is not admitted until it is verified again.
test("SB-2 admits only node-verified claims, so an asserted or persisted citation evicts no one", async (t) => {
  const { sellers, winner, later } = crossSellerCatalog();
  later.settlementTxIds = [{ ...later.settlementTxIds![0], observedAt: 1, nodeVerified: undefined }];
  assert.deepEqual(settlementEligibleDeals([later, winner]), [winner]);
  const mixed = deal({ settlementTxIds: [{ id: "demos:own", observedAt: 5, phaseIndex: 2, nodeVerified: true }, { id: "demos:cited", observedAt: 5, phaseIndex: 3 }] });
  assert.deepEqual(settlementEligibleDeals([mixed]), [], "one unverified citation is enough to withhold the deal");
  reconcileCatalogReputation(sellers, 100);
  assert.deepEqual(sellers.map((seller) => [seller.deals[0].settlementRejected, seller.reputation.completed]), [[undefined, 1], [true, 0]]);

  // index-now recomputes the ledger over persisted sellers it did not verify again.
  const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-reputation-provenance-"));
  const previous = process.env.DACS_DIRECTORY_DATA;
  process.env.DACS_DIRECTORY_DATA = dataDirectory;
  t.after(() => {
    if (previous === undefined) delete process.env.DACS_DIRECTORY_DATA; else process.env.DACS_DIRECTORY_DATA = previous;
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  const { loadCatalog, saveCatalog } = await import("../src/catalog/store.js");
  saveCatalog({ catalogVersion: "1", generatedAt: 100, sellers: [sellers[1]] });
  const persisted = loadCatalog();
  persisted.sellers.push({ ...sellers[0], deals: [{ ...winner, settlementRejected: undefined }] });
  saveCatalog(persisted);
  assert.deepEqual(loadCatalog().sellers.map((seller) => [seller.primaryClaim, seller.reputation.completed]), [[sellers[1].primaryClaim, 0], [SELLER, 1]]);
});

test("equal-time/hash/job settlement claims choose the lower phase index in both insertion orders", () => {
  const claim = { id: "shared", observedAt: 1, evidenceHash: "a".repeat(64), nodeVerified: true };
  const low = deal({ jobId: "same", settlementTxIds: [{ ...claim, phaseIndex: 0 }] });
  const high = deal({ jobId: "same", settlementTxIds: [{ ...claim, phaseIndex: 1 }] });
  assert.deepEqual(settlementEligibleDeals([low, high]), [low]);
  assert.deepEqual(settlementEligibleDeals([high, low]), [low]);
});

// DACS-5 §10.5.1 at run time (daybreak P1-1, P1-2; code F-A). A session this pass could not decide counts neither as
// completed nor as failed. Each rate it could change is null, with the range it can take once every such session is
// decided or refuted. The low end, which filters and ranking use, credits no undecided completion.
const undecidedDeal = (sellerOutcomes: string[], change: Partial<DealRecord> = {}, ratingsAtMost = 0) => deal({ refsVerified: false, reputationEligible: false,
  sellerOutcome: undefined, bundleContentHash: undefined, undecided: { kind: "no-answer", reason: "the node had no answer", sellerOutcomes, ratingsAtMost }, ...change });

test("rateRange: the low end counts every possible failure, the high end every possible completion", () => {
  assert.deepEqual(rateRange(0, 1, 1, 0), { low: 0, high: 0.5 });
  assert.deepEqual(rateRange(1, 1, 0, 1), { low: 0.5, high: 1 });
  assert.deepEqual(rateRange(2, 4, 0, 0), { low: 0.5, high: 0.5 });
  // No decided denominator: there is no verified low end at all, so no undecided session can create one.
  assert.deepEqual(rateRange(0, 0, 3, 0), { low: null, high: 1 });
  assert.deepEqual(rateRange(0, 0, 0, 2), { low: null, high: 0 });
  assert.deepEqual(rateRange(0, 0, 0, 0), { low: null, high: null });
});

test("an undecided session leaves each rate it can move null, with its range, and every other figure decided", () => {
  const derived = deriveSellerReputation([deal({ sellerOutcome: "failed-perm" }), undecidedDeal(["completed"])], 0, 100);
  assert.equal(derived.completed, 0); assert.equal(derived.bundleCount, 1); assert.equal(derived.undecidedSessions, 1);
  assert.equal(derived.completionRate, null); assert.deepEqual(derived.completionRateRange, { low: 0, high: 0.5 });
  assert.equal(derived.counterpartyAdjustedCompletionRate, null); assert.deepEqual(derived.counterpartyAdjustedCompletionRateRange, { low: 0, high: 0.5 });
  // The failure is the seller's own, so the counterparty-fault rate is 0 either way and stays a point.
  assert.equal(derived.counterpartyFaultRate, 0); assert.deepEqual(derived.counterpartyFaultRateRange, { low: 0, high: 0 });
  // An undecided failure lowers the floor and caps nothing: it may still count.
  const failure = deriveSellerReputation([deal(), undecidedDeal(["failed-perm"])], 0, 100);
  assert.equal(failure.completionRate, null); assert.deepEqual(failure.completionRateRange, { low: 0.5, high: 1 });
  // A substrate failure moves no party rate.
  const substrate = deriveSellerReputation([deal(), undecidedDeal(["failed-substrate"])], 0, 100);
  assert.equal(substrate.completionRate, 1); assert.deepEqual(substrate.completionRateRange, { low: 1, high: 1 }); assert.equal(substrate.undecidedSessions, 1);
  // An outcome the copies do not state is either.
  assert.deepEqual(deriveSellerReputation([deal(), undecidedDeal([])], 0, 100).completionRateRange, { low: 0.5, high: 1 });
  // Without undecided sessions nothing new is published.
  const decided = deriveSellerReputation([deal()], 0, 100);
  assert.equal("undecidedSessions" in decided || "completionRateRange" in decided, false);
});

test("the ratings an undecided session could add leave the average null, with its range", () => {
  const rated = (value: number, change: Partial<DealRecord> = {}) => deal({ ...change, ratings: [{ rater: "did:demos:agent:buyer", target: SELLER,
    targetRole: "seller", value, ratedAt: 1, contentHash: `${value}`.repeat(64) }] });
  // Daybreak P1-1's shape for ratings: a completion rated 5 left out beside a failure rated 1 published 1.
  const derived = deriveSellerReputation([rated(1, { sellerOutcome: "failed-perm" }), undecidedDeal(["completed"], {}, 1)], 0, 100);
  assert.equal(derived.averageSellerRating, null);
  assert.deepEqual(derived.averageSellerRatingRange, { low: 1, high: 3 });
  // Every value the undecided rating can take lands inside, and so does leaving it out.
  for (const value of [1, 2, 3, 4, 5]) {
    const average = deriveSellerReputation([rated(1, { sellerOutcome: "failed-perm" }), rated(value)], 0, 100).averageSellerRating!;
    assert.ok(average >= 1 && average <= 3, String(value));
  }
  assert.deepEqual(deriveSellerReputation([rated(4), undecidedDeal(["failed-perm"], {}, 2)], 0, 100).averageSellerRatingRange, { low: 2, high: 14 / 3 });
  // No decided rating: no low end. A session that cites no rating leaves the average a point.
  assert.deepEqual(deriveSellerReputation([undecidedDeal(["completed"], {}, 1)], 0, 100).averageSellerRatingRange, { low: null, high: 5 });
  const unrated = deriveSellerReputation([rated(4), undecidedDeal(["completed"])], 0, 100);
  assert.equal(unrated.averageSellerRating, 4); assert.deepEqual(unrated.averageSellerRatingRange, { low: 4, high: 4 });
  // A malformed count could be one rating per other party.
  const malformed = undecidedDeal(["completed"], {}, Number.NaN);
  assert.deepEqual(deriveSellerReputation([rated(4), malformed], 0, 100).averageSellerRatingRange, { low: 2, high: 14 / 3 });
  assert.deepEqual(categoryReputationHint("rules", [rated(4, { category: "rules" }), undecidedDeal(["completed"], { category: "rules" }, 1)], 0, 100, 100).averageSellerRatingRange,
    { low: 2.5, high: 4.5 });
});

test("an undecided session counts once, only in its window, and never beside a decided record of itself", () => {
  const session = { jobId: "one-session", owners: { buyer: "did:demos:agent:buyer", seller: SELLER } };
  const counted = (deals: DealRecord[]) => deriveSellerReputation(deals, 5, 50).undecidedSessions ?? 0;
  assert.equal(counted([undecidedDeal(["completed"], session), undecidedDeal(["completed"], { ...session, buyerBundleRef: "stor-other" })]), 1);
  assert.equal(counted([undecidedDeal(["completed"], session), deal({ ...session, sellerOutcome: "failed-perm" })]), 0);
  assert.equal(counted([undecidedDeal(["completed"], session), deal({ ...session, reputationEligible: false })]), 0);
  assert.equal(counted([undecidedDeal(["completed"], { finalisedAt: 60 })]), 0);
  assert.equal(counted([undecidedDeal(["completed"], { finalisedAt: 60, anchorTimestamp: 40 })]), 1);
  assert.equal(counted([undecidedDeal(["completed"], { finalisedAt: undefined })]), 0);
  // A stored record without owners (as older fixtures and catalogs hold) neither throws nor hides an undecided session.
  const ownerless = { ...deal(), owners: undefined } as unknown as DealRecord;
  assert.equal(counted([ownerless, undecidedDeal(["completed"])]), 1);
  assert.equal(deriveSellerReputation([ownerless], 0, 100).bundleCount, 1);
  // Two undecided records of one session merge the outcomes their copies claim.
  assert.deepEqual(deriveSellerReputation([deal(), undecidedDeal(["completed"], session), undecidedDeal(["failed-perm"], session)], 0, 100).completionRateRange,
    { low: 0.5, high: 1 });
});

test("listing hints carry the undecided sessions of their category, and those of no known category in every hint", () => {
  const deals = [deal({ category: "data.finance", sellerOutcome: "failed-perm" }), undecidedDeal(["completed"], { category: "data.finance.fx" })];
  const hint = categoryReputationHint("data.finance", deals, 0, 100, 100);
  assert.equal(hint.completionRate, null); assert.equal(hint.bundleCount, 1); assert.equal(hint.undecidedSessions, 1);
  assert.deepEqual(hint.completionRateRange, { low: 0, high: 0.5 });
  const other = categoryReputationHint("media", deals, 0, 100, 100);
  assert.equal("undecidedSessions" in other || "completionRateRange" in other, false);
  const unknown = categoryReputationHint("media", [...deals, undecidedDeal(["completed"], { category: undefined })], 0, 100, 100);
  assert.equal(unknown.undecidedSessions, 1); assert.deepEqual(unknown.completionRateRange, { low: null, high: 1 });
  // The catalog-wide pass recomputes the same figures from the stored deals.
  const seller = { primaryClaim: SELLER, displayName: "s", cci: [], deals, reputation: { completed: 0, totalAgreements: 0, completionRate: null },
    listings: [{ offering: { category: "data.finance" } }], registeredAt: 0, lastIndexedAt: 0 } as unknown as SellerRecord;
  reconcileCatalogReputation([seller], 100);
  assert.deepEqual(seller.reputation.completionRateRange, { low: 0, high: 0.5 }); assert.equal(seller.reputation.undecidedSessions, 1);
  assert.deepEqual(seller.listings[0].reputationHint?.completionRateRange, { low: 0, high: 0.5 });
});

// Exhaustive over small catalogs: every way the undecided sessions can be decided or refuted gives a rate inside the
// published range, a published point is the only value they can give, and the low end never rises when a decided
// session becomes undecided or an undecided one is added. So undecided sessions can neither hide a failure from the
// floor nor raise it.
test("the range contains every outcome the undecided sessions can have, and its low end cannot be raised by them", () => {
  const OUTCOMES = ["completed", "failed-perm", "failed-counterparty", "failed-substrate"];
  const RATES = ["completionRate", "counterpartyAdjustedCompletionRate", "counterpartyFaultRate"] as const;
  type Derived = ReturnType<typeof deriveSellerReputation>;
  const lowEnd = (derived: Derived, rate: typeof RATES[number]) => (derived[`${rate}Range`] ? derived[`${rate}Range`]!.low : derived[rate]) ?? -1;
  const derive = (decided: string[], undecided: string[]) =>
    deriveSellerReputation([...decided.map((sellerOutcome) => deal({ sellerOutcome })), ...undecided.map((outcome) => undecidedDeal([outcome]))], 0, 100);
  const resolutions = (undecided: string[]): string[][] => undecided.length === 0 ? [[]]
    : resolutions(undecided.slice(1)).flatMap((rest) => [rest, [undecided[0], ...rest]]);
  const multisets = (size: number, from = 0): string[][] => size === 0 ? [[]]
    : OUTCOMES.slice(from).flatMap((outcome, index) => multisets(size - 1, from + index).map((rest) => [outcome, ...rest]));
  let checked = 0;
  for (const decided of [0, 1, 2].flatMap((size) => multisets(size))) for (const undecided of [0, 1, 2].flatMap((size) => multisets(size))) {
    const published = derive(decided, undecided);
    const label = `${decided.join(",")} | ${undecided.join(",")}`;
    for (const resolved of resolutions(undecided)) {
      const eventual = derive([...decided, ...resolved], []);
      for (const rate of RATES) {
        const value = eventual[rate] ?? null;
        const point = published[rate] ?? null;
        const range = published[`${rate}Range`] ?? { low: point, high: point };
        if (point !== null) assert.equal(value, point, `${rate} ${label} -> ${resolved.join(",")}`);
        if (value !== null) assert.ok((range.low ?? -1) <= value && range.high !== null && value <= range.high, `${rate} ${label} -> ${resolved.join(",")}`);
        checked++;
      }
    }
    // Making one decided session undecided, or adding one, never raises a low end.
    for (const index of decided.keys()) {
      const moved = derive(decided.filter((_, other) => other !== index), [...undecided, decided[index]]);
      for (const rate of RATES) assert.ok(lowEnd(moved, rate) <= lowEnd(published, rate), `${rate} moved ${label}`);
    }
    for (const outcome of OUTCOMES) {
      const added = derive(decided, [...undecided, outcome]);
      for (const rate of RATES) assert.ok(lowEnd(added, rate) <= lowEnd(published, rate), `${rate} added ${outcome} to ${label}`);
    }
  }
  assert.ok(checked > 1000, String(checked));
});
