import assert from "node:assert/strict";
import test from "node:test";
import { legacyCopyCanVerifyRefs, reconcileLegacyCopies } from "../src/catalog/currentReconciliation.js";
import { deriveSellerReputation } from "../src/catalog/reputation.js";
import type { DealRecord } from "../src/catalog/types.js";

const copy = (refsOk = true, outcome = "completed", phaseOutcome = "ok") => ({
  refsOk,
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
