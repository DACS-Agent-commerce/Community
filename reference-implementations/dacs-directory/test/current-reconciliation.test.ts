import assert from "node:assert/strict";
import test from "node:test";
import { currentBundleCopiesDiverge, phaseSummariesDiverge, reconcileCurrentCopies } from "../src/catalog/currentReconciliation.js";
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
    ["completed", "completed", "none", 1],
    ["failed-substrate", "failed-substrate", "none", 0],
    ["failed-perm", "failed-counterparty", "buyer", 0],
    ["failed-counterparty", "failed-perm", "seller", 0],
    ["aborted-by-self", "aborted-by-other", "buyer", 0],
    ["aborted-by-other", "aborted-by-self", "seller", 0],
    ["failed-counterparty", "failed-counterparty", "orchestrator", 0],
    ["aborted-by-other", "aborted-by-other", "orchestrator", 0],
  ] as const;
  for (const [buyerOutcome, sellerOutcome, faultedParty, completed] of cases) {
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
    // TP-1: testnet completion and fault rates are unavailable for every outcome.
    assert.equal(reputation.completionRate, null);
    assert.equal(reputation.counterpartyFaultRate, null);
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

test("absolute-fault copies that disagree on faultedParty or outcome class are a dispute, never reputation", () => {
  // DACS-5 §10.4.3: two fault-bundle copies diverge when faultedParty, the
  // outcome class or a shared phaseSummary entry differ. Each copy below is
  // permissible on its own and the phase summaries agree, so only the named
  // limb can make the pair divergent.
  const graph = (role: "buyer" | "seller", outcome: string, faultedParty: string): EvidenceGraph => ({
    profile: "dacs-v0.1", ok: true, signaturesVerified: true, refsVerified: true,
    bundleContentHash: `${role}-hash`, artifacts: [], ratings: [],
    bundle: { faultBundleVersion: "1", jobId: "fault", anchoredByRole: role, outcome, faultedParty,
      parties: [{ role: "buyer", primaryClaim: buyer }, { role: "seller", primaryClaim: seller }],
      phaseSummary: [phase] },
  });
  const disputes = [
    // Same faultedParty, different class: the buyer reports a failure, the seller an abort.
    ["class", ["failed-counterparty", "seller"], ["aborted-by-self", "seller"]],
    ["class", ["aborted-by-other", "seller"], ["failed-perm", "seller"]],
    ["class", ["completed", "none"], ["failed-substrate", "none"]],
    // Same class, different faultedParty: each copy blames the other party.
    ["faultedParty", ["failed-counterparty", "seller"], ["failed-counterparty", "buyer"]],
    ["faultedParty", ["aborted-by-self", "buyer"], ["aborted-by-self", "seller"]],
    ["faultedParty", ["failed-counterparty", "orchestrator"], ["failed-counterparty", "buyer"]],
  ] as const;
  for (const [limb, [buyerOutcome, buyerFault], [sellerOutcome, sellerFault]] of disputes) {
    const label = `${limb}: buyer ${buyerOutcome}/${buyerFault}, seller ${sellerOutcome}/${sellerFault}`;
    const buyerGraph = graph("buyer", buyerOutcome, buyerFault);
    const sellerGraph = graph("seller", sellerOutcome, sellerFault);
    assert.equal(currentBundleCopiesDiverge(buyerGraph.bundle, sellerGraph.bundle), true, label);
    assert.equal(currentBundleCopiesDiverge(sellerGraph.bundle, buyerGraph.bundle), true, label);
    const result = reconcileCurrentCopies(deal, seller, buyerGraph, sellerGraph);
    assert.equal(result.buyerOk, true, label);
    assert.equal(result.sellerOk, true, label);
    assert.equal(result.divergent, true, label);
    assert.equal(result.refsVerified, false, label);
    const record: DealRecord = { ...deal, signatureVerified: true, refsVerified: result.refsVerified,
      reputationEligible: result.refsVerified, sellerOutcome: result.sellerOutcome,
      faultedParty: sellerFault, finalisedAt: 100, verifiedAt: 100 };
    assert.equal(deriveSellerReputation([record], 0, 200).bundleCount, 0, label);
  }
  // Role-relative respellings of one absolute fault are the same claim.
  const agreed = reconcileCurrentCopies(deal, seller,
    graph("buyer", "aborted-by-other", "seller"), graph("seller", "aborted-by-self", "seller"));
  assert.equal(agreed.divergent, false);
  assert.equal(agreed.refsVerified, true);
});

test("orchestrator faults remain in bundle counts while testnet fault denominators are unavailable", () => {
  const base = { ...deal, signatureVerified: true, refsVerified: true, reputationEligible: true,
    finalisedAt: 100, verifiedAt: 100 };
  const reputation = deriveSellerReputation([
    { ...base, jobId: "completed", sellerOutcome: "completed", faultedParty: "none" },
    { ...base, jobId: "orchestrator-failure", sellerOutcome: "failed-counterparty", faultedParty: "orchestrator" },
    { ...base, jobId: "orchestrator-abort", sellerOutcome: "aborted-by-other", faultedParty: "orchestrator" },
  ], 0, 200);
  assert.equal(reputation.bundleCount, 3);
  assert.equal(reputation.completed, 1);
  assert.equal(reputation.completionRate, null);
  assert.equal(reputation.counterpartyAdjustedCompletionRate, null);
  assert.equal(reputation.counterpartyFaultRate, null);
});
