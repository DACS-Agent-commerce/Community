import assert from "node:assert/strict";
import test from "node:test";
import { legacyCopyCanVerifyRefs, reconcileLegacyCopies } from "../src/catalog/currentReconciliation.js";
import { deriveSellerReputation } from "../src/catalog/reputation.js";
import type { DealRecord } from "../src/catalog/types.js";

const copy = (refsOk = true, outcome = "completed", phaseOutcome = "ok") => ({
  refsOk, authenticated: refsOk,
  commitmentContext: { jobId: "job", listingRef: { listingId: "svc", version: 1, contentHash: "a".repeat(64) },
    agreementHash: "b".repeat(64), pattern: "fixed-price" as const, parties: ["buyer", "seller"] as const,
    deadline: 1000, validity: { notBefore: 0 } },
  bundle: { bundleVersion: "1", outcome, phaseSummary: [{ index: 0, kind: "commit-agreement", outcome: phaseOutcome }] },
});

test("legacy reference admission requires valid signatures, deal binding, and the expected copy role", () => {
  for (const expected of ["buyer", "seller"] as const) {
    assert.equal(legacyCopyCanVerifyRefs(true, true, expected, expected), true);
    assert.equal(legacyCopyCanVerifyRefs(false, true, expected, expected), false, "invalid signatures");
    assert.equal(legacyCopyCanVerifyRefs(true, false, expected, expected), false, "another registered deal");
    for (const role of ["buyer", "seller", "orchestrator", undefined]) {
      if (role !== expected) assert.equal(legacyCopyCanVerifyRefs(true, true, role, expected), false, `unexpected role ${role}`);
    }
  }
});

test("legacy completion requires two authenticated agreeing copies and a terminal outcome", () => {
  // Exercise the policy independently of the pinned SDK, which cannot yet
  // authenticate legacy agreement references. Each false gate has a true peer.
  const cases: Array<[string, ReturnType<typeof copy>, ReturnType<typeof copy> | null, boolean, boolean]> = [
    ["both valid", copy(), copy(), true, true],
    ["buyer invalid", copy(false), copy(), false, false],
    ["seller invalid", copy(), copy(false), false, false],
    ["both invalid", copy(false), copy(false), false, false],
    ["seller absent", copy(), null, false, false],
    ["contradictory phase", copy(), copy(true, "completed", "fail"), false, false],
    ["contradictory outcome", copy(), copy(true, "failed-substrate"), false, false],
    ["nonterminal outcome", copy(true, "pending"), copy(true, "pending"), true, false],
  ];
  for (const [name, buyer, seller, refsVerified, eligible] of cases) {
    const result = reconcileLegacyCopies(buyer, seller);
    assert.equal(result.refsVerified, refsVerified, name);
    assert.equal(result.reputationEligible, eligible, name);
    const reputation = deriveSellerReputation([{
      jobId: name, owners: { buyer: "buyer", seller: "seller" }, buyerBundleRef: "stor-buyer",
      signatureVerified: true, ...result, anchorTimestamp: 100, verifiedAt: 100,
    } as unknown as DealRecord], 0, 200);
    assert.equal(reputation.bundleCount, eligible ? 1 : 0, name);
    assert.equal(reputation.completed, eligible ? 1 : 0, name);
  }
});

test("legacy completion refuses authenticated copies that carry no bundle", () => {
  for (const [name, buyer, seller] of [
    ["neither bundle", { refsOk: true }, { refsOk: true }],
    ["buyer bundle missing", { refsOk: true }, copy()],
    ["seller bundle missing", copy(), { refsOk: true }],
  ] as const) {
    const result = reconcileLegacyCopies(buyer, seller);
    assert.equal(result.refsVerified, false, name);
    assert.equal(result.reputationEligible, false, name);
  }
});

test("legacy authority selects the verified seller copy and reports seller-relative outcomes", () => {
  const buyer = copy(true, "aborted-by-self");
  const seller = copy(true, "aborted-by-other");
  const both = reconcileLegacyCopies(buyer, seller);
  assert.equal(both.authoritative, seller);
  assert.equal(both.sellerOutcome, "aborted-by-other");
  assert.equal(both.refsVerified, true);
  assert.equal(both.reputationEligible, true);
  const one = reconcileLegacyCopies(buyer, null);
  assert.equal(one.authoritative, buyer);
  assert.equal(one.sellerOutcome, "aborted-by-other");
  assert.equal(one.reputationEligible, false);
});

test("all six agreeing terminal outcomes remain eligible observations without rates under TP-1", () => {
  const outcomes = [
    ["completed", "completed", 1],
    ["failed-counterparty", "failed-perm", 0],
    ["failed-perm", "failed-counterparty", 0],
    ["failed-substrate", "failed-substrate", 0],
    ["aborted-by-other", "aborted-by-self", 0],
    ["aborted-by-self", "aborted-by-other", 0],
  ] as const;
  const deals: DealRecord[] = [];
  for (const [buyerOutcome, sellerOutcome, completed] of outcomes) {
    const buyer = copy(true, buyerOutcome);
    const seller = copy(true, sellerOutcome);
    const result = reconcileLegacyCopies(buyer, seller);
    assert.equal(result.authoritative, seller, sellerOutcome);
    assert.equal(result.sellerOutcome, sellerOutcome);
    assert.equal(result.refsVerified, true, sellerOutcome);
    assert.equal(result.reputationEligible, true, sellerOutcome);
    const deal = {
      jobId: sellerOutcome, owners: { buyer: "buyer", seller: "seller" }, buyerBundleRef: "stor-buyer",
      signatureVerified: true, ...result, finalisedAt: 100, verifiedAt: 100,
    } as unknown as DealRecord;
    deals.push(deal);
    const reputation = deriveSellerReputation([deal], 0, 200);
    assert.deepEqual({ count: reputation.bundleCount, agreements: reputation.totalAgreements,
      completed: reputation.completed, rate: reputation.completionRate,
      adjusted: reputation.counterpartyAdjustedCompletionRate, faultRate: reputation.counterpartyFaultRate },
    { count: 1, agreements: 1, completed, rate: null, adjusted: null, faultRate: null }, sellerOutcome);
  }
  const all = deriveSellerReputation(deals, 0, 200);
  assert.equal(all.bundleCount, 6);
  assert.equal(all.completed, 1);
  assert.equal(all.completionRate, null);
  assert.equal(all.counterpartyAdjustedCompletionRate, null);
  assert.equal(all.counterpartyFaultRate, null);
});

test("legacy copies cannot share credit across different commitment contexts", () => {
  const buyer = copy(); const seller = copy();
  seller.commitmentContext.agreementHash = "c".repeat(64);
  const result = reconcileLegacyCopies(buyer, seller);
  assert.equal(result.authoritative, seller);
  assert.equal(result.refsVerified, false);
});
