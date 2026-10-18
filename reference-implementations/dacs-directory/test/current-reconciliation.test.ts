import assert from "node:assert/strict";
import test from "node:test";
import { phaseSummariesDiverge, reconcileCurrentCopies } from "../src/catalog/currentReconciliation.js";
import { deriveSellerReputation } from "../src/catalog/reputation.js";
import type { EvidenceGraph } from "../src/catalog/evidenceGraph.js";
import type { DealRecord, RegisteredDeal } from "../src/catalog/types.js";

const buyer = `did:demos:agent:${"a".repeat(64)}`;
const seller = `did:demos:agent:${"b".repeat(64)}`;
const orchestrator = `did:demos:agent:${"c".repeat(64)}`;
const deal: RegisteredDeal = { jobId: "fault", rail: "pay-dem", owners: { buyer, seller },
  buyerBundleRef: "buyer-copy", sellerBundleRef: "seller-copy" };
const phase = { index: 0, kind: "settle", outcome: "ok" };

test("phase presence diverges in either direction even when one phase set is empty", () => {
  assert.equal(phaseSummariesDiverge([], []), false);
  assert.equal(phaseSummariesDiverge([], [phase]), true);
  assert.equal(phaseSummariesDiverge([phase], []), true);
});

test("fault reconciliation uses absolute attribution for every outcome and buyer-copy fallback", () => {
  // Independent expected buyer/seller outcomes and absolute attribution. In
  // orchestrator cases both counterparties report the same relative outcome.
  const cases = [
    ["completed", "completed", "none", 1, 1, 0],
    ["failed-substrate", "failed-substrate", "none", 0, null, null],
    ["failed-perm", "failed-counterparty", "buyer", 0, 0, 1],
    ["failed-counterparty", "failed-perm", "seller", 0, 0, 0],
    ["aborted-by-self", "aborted-by-other", "buyer", 0, 0, 1],
    ["aborted-by-other", "aborted-by-self", "seller", 0, 0, 0],
    ["failed-counterparty", "failed-counterparty", "orchestrator", 0, null, null],
    ["aborted-by-other", "aborted-by-other", "orchestrator", 0, null, null],
  ] as const;
  for (const [buyerOutcome, sellerOutcome, faultedParty, completed, rate, faultRate] of cases) {
    const graph = (role: "buyer" | "seller", outcome: string): EvidenceGraph => ({
      profile: "dacs-v0.1", ok: true, signaturesVerified: true, refsVerified: true,
      bundleContentHash: `${role}-hash`, artifacts: [], ratings: [],
      bundle: { faultBundleVersion: "1", jobId: "fault", anchoredByRole: role, outcome, faultedParty,
        parties: [{ role: "buyer", primaryClaim: buyer }, { role: "seller", primaryClaim: seller },
          { role: "orchestrator", primaryClaim: orchestrator }], phaseSummary: [phase] },
    });
    const buyerGraph = graph("buyer", buyerOutcome);
    const sellerGraph = graph("seller", sellerOutcome);
    const result = reconcileCurrentCopies(deal, seller, buyerGraph, sellerGraph);
    assert.equal(result.buyerOk, true);
    assert.equal(result.sellerOk, true);
    assert.equal(result.divergent, false, `${faultedParty}: ${sellerOutcome}`);
    assert.equal(result.refsVerified, true);
    assert.equal(result.sellerOutcome, sellerOutcome);
    assert.equal(result.authoritative, sellerGraph);
    assert.equal(result.selectedLocator, "seller-copy");
    const record: DealRecord = { ...deal, signatureVerified: true, refsVerified: result.refsVerified,
      reputationEligible: result.refsVerified, sellerOutcome: result.sellerOutcome,
      faultedParty, finalisedAt: 100, verifiedAt: 100 };
    const reputation = deriveSellerReputation([record], 0, 200);
    assert.equal(reputation.bundleCount, 1);
    assert.equal(reputation.completed, completed);
    assert.equal(reputation.completionRate, rate);
    assert.equal(reputation.counterpartyFaultRate, faultRate);
    for (const unavailable of [null, { ...sellerGraph, ok: false }]) {
      const fallback = reconcileCurrentCopies(deal, seller, buyerGraph, unavailable);
      assert.equal(fallback.buyerOk, true);
      assert.equal(fallback.sellerOk, false);
      assert.equal(fallback.divergent, false);
      assert.equal(fallback.refsVerified, false);
      assert.equal(fallback.sellerOutcome, sellerOutcome, `buyer fallback: ${faultedParty}`);
      assert.equal(fallback.authoritative, buyerGraph);
      assert.equal(fallback.selectedLocator, "buyer-copy");
      assert.equal(deriveSellerReputation([{ ...record, refsVerified: false, reputationEligible: false }], 0, 200).bundleCount, 0);
    }
    const contradictory = { ...sellerGraph, bundle: { ...sellerGraph.bundle,
      phaseSummary: [{ ...phase, outcome: "fail" }] } };
    assert.equal(reconcileCurrentCopies(deal, seller, buyerGraph, contradictory).divergent, true);
    assert.equal(reconcileCurrentCopies(deal, seller, buyerGraph, contradictory).refsVerified, false);
  }
});

test("orchestrator faults remain in bundle counts but not in buyer/seller fault denominators", () => {
  const base = { ...deal, signatureVerified: true, refsVerified: true, reputationEligible: true,
    finalisedAt: 100, verifiedAt: 100 };
  const reputation = deriveSellerReputation([
    { ...base, jobId: "completed", sellerOutcome: "completed", faultedParty: "none" },
    { ...base, jobId: "orchestrator-failure", sellerOutcome: "failed-counterparty", faultedParty: "orchestrator" },
    { ...base, jobId: "orchestrator-abort", sellerOutcome: "aborted-by-other", faultedParty: "orchestrator" },
  ], 0, 200);
  assert.equal(reputation.bundleCount, 3);
  assert.equal(reputation.completed, 1);
  assert.equal(reputation.completionRate, 1);
  assert.equal(reputation.counterpartyAdjustedCompletionRate, 1);
  assert.equal(reputation.counterpartyFaultRate, 0);
});
