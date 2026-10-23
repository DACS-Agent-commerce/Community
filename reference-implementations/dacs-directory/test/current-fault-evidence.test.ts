import assert from "node:assert/strict";
import test from "node:test";
import { signedScope } from "../src/catalog/evidenceGraph.js";
import { reconcileCurrentCopies } from "../src/catalog/currentReconciliation.js";
import { deriveSellerReputation } from "../src/catalog/reputation.js";
import type { DealRecord } from "../src/catalog/types.js";
import { type Obj, dids, maps, sign, vector, graphAt, registeredDeal } from "./fixtures/current-evidence.js";

test("signed fault copies reconcile all six outcomes and orchestrator attribution", async () => {
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
  for (const [index, [buyerOutcome, sellerOutcome, faultedParty, completed]] of cases.entries()) {
    const jobId = `signed-fault-${index}`;
    const fixture = await vector(jobId, index * 10);
    for (const [role, outcome, raw, at] of [
      ["buyer", buyerOutcome, fixture.buyerBundle, fixture.locators.buyer],
      ["seller", sellerOutcome, fixture.sellerBundle, fixture.locators.seller],
    ] as const) {
      const scope = signedScope(raw, "bundle");
      delete scope.bundleVersion;
      Object.assign(scope, { faultBundleVersion: "1", faultedParty, outcome });
      scope.parties = [...scope.parties as Obj[], { role: "orchestrator", primaryClaim: dids[2], bundleHash: "c".repeat(64) }];
      maps.set(at, { ...scope, signatures: await Promise.all([0, 1, 2].map((n) => sign(scope, "bundle", n, true))), anchoredByRole: role });
    }
    const buyer = await graphAt(fixture.locators.buyer, fixture.listing, fixture.locators.listing);
    const seller = await graphAt(fixture.locators.seller, fixture.listing, fixture.locators.listing);
    assert.equal(buyer.ok, true, buyer.reason);
    assert.equal(seller.ok, true, seller.reason);
    assert.equal(buyer.signaturesVerified, true);
    assert.equal(seller.signaturesVerified, true);
    const deal = registeredDeal(jobId, fixture.locators.buyer, fixture.locators.seller);
    const result = reconcileCurrentCopies(deal, dids[1], buyer, seller);
    assert.deepEqual({ buyerOk: result.buyerOk, sellerOk: result.sellerOk, divergent: result.divergent,
      refsVerified: result.refsVerified, sellerOutcome: result.sellerOutcome, locator: result.selectedLocator },
    { buyerOk: true, sellerOk: true, divergent: false, refsVerified: true, sellerOutcome, locator: fixture.locators.seller });
    const record: DealRecord = { ...deal, signatureVerified: result.authoritative.signaturesVerified,
      refsVerified: result.refsVerified, reputationEligible: result.refsVerified, sellerOutcome: result.sellerOutcome,
      faultedParty, finalisedAt: 120, verifiedAt: 100 };
    const reputation = deriveSellerReputation([record], 0, 200);
    assert.equal(reputation.bundleCount, 1);
    assert.equal(reputation.completed, completed);
    // TP-1: testnet completion and fault rates are unavailable for every outcome.
    assert.equal(reputation.completionRate, null);
    assert.equal(reputation.counterpartyFaultRate, null);
    const fallback = reconcileCurrentCopies(deal, dids[1], buyer, null);
    assert.equal(fallback.sellerOutcome, sellerOutcome);
    assert.equal(fallback.selectedLocator, fixture.locators.buyer);
    assert.equal(fallback.refsVerified, false);
  }
});
