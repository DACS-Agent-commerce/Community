import assert from "node:assert/strict";
import test from "node:test";
import { settlementTxId, legacySettlementTxId } from "../src/catalog/settlementKey.js";
import { currentBundleCopiesDiverge, reconcileCurrentCopies } from "../src/catalog/currentReconciliation.js";
import { deriveSellerReputation } from "../src/catalog/reputation.js";
import { PUBLISHABLE_RAIL_OPTIONS, publishableRail } from "../src/catalog/listingOptions.js";
import { verifyNativePayment, demOs, type SettlementNodeRead } from "../src/catalog/nativePayment.js";
import type { EvidenceGraph } from "../src/catalog/evidenceGraph.js";
import { activeCatalogListings, activeCatalogSellers } from "../src/catalog/discovery.js";
import type { Catalog, SellerRecord } from "../src/catalog/types.js";
import type { DealRecord } from "../src/catalog/types.js";

test("SB-1 malformed indices never mint settlement identities", () => {
  const txHash = "ab".repeat(32);
  for (const logIndex of [undefined, "0", "00", -1, 1.5, null]) {
    assert.equal(settlementTxId({ kind: "evm", chainId: 8453, txHash, logIndex }), null, String(logIndex));
    assert.equal(settlementTxId({ kind: "x402", chainId: 8453, settlementTxHash: txHash, logIndex }), null);
  }
  assert.equal(settlementTxId({ kind: "evm", chainId: "8453", txHash, logIndex: 0 }), null);
  for (const instructionIndex of [undefined, -1]) assert.equal(settlementTxId({ kind: "solana", cluster: "devnet", signature: "1".repeat(64), instructionIndex }), null);
  const legacy = { rail: "demos", kind: "payment", txHash };
  assert.equal(legacySettlementTxId("pay-evm-erc20", legacy), null);
  assert.equal(legacySettlementTxId("pay-dem", legacy), `demos:${txHash}`);
});

test("publisher rail IDs and phase kinds follow the pinned DACS-4 registry", () => {
  assert.deepEqual(PUBLISHABLE_RAIL_OPTIONS.map(({ railId, phaseKind }) => [railId, phaseKind]), [
    ["demos-native:DEM", "pay-dem"], ["x402:default", "pay-x402"], ["ap2:stripe-paymentintents", "pay-ap2"],
  ]);
  assert.equal(publishableRail("pay-dem"), undefined);
  assert.equal(publishableRail("pay-x402"), undefined);
});

const parties = [{ role: "buyer", primaryClaim: `did:demos:agent:${"1".repeat(64)}` }, { role: "seller", primaryClaim: `did:demos:agent:${"2".repeat(64)}` }, { role: "orchestrator", primaryClaim: `did:demos:agent:${"3".repeat(64)}` }];
const deal = { jobId: "sweep", rail: "demos-native:DEM", owners: { buyer: parties[0].primaryClaim, seller: parties[1].primaryClaim }, buyerBundleRef: "stor-b", sellerBundleRef: "stor-s" };
const bundle = (role: string, outcome: string, faultedParty: string) => ({ faultBundleVersion: "1", jobId: deal.jobId, parties, anchoredByRole: role, outcome, faultedParty, phaseSummary: [{ index: 0, kind: "pay-dem", outcome: "ok" }] });
const graph = (bundle: Record<string, unknown>): EvidenceGraph => ({ profile: "dacs-v0.1", ok: true, refsVerified: true, signaturesVerified: true, signedParties: parties.map((p) => p.primaryClaim), artifacts: [], settlement: [], ratings: [], flaggedAmendments: [], bundleContentHash: "a".repeat(64), bundle });

test("FAB outcome-class divergence excludes completed/substrate and abort/failure pairs", () => {
  for (const [left, right, fault] of [["completed", "failed-substrate", "none"], ["aborted-by-self", "failed-counterparty", "buyer"]]) {
    const buyer = bundle("buyer", left, fault), seller = bundle("seller", right, fault);
    assert.equal(currentBundleCopiesDiverge(buyer, seller), true);
    const reconciled = reconcileCurrentCopies(deal, parties[1].primaryClaim, graph(buyer), graph(seller));
    assert.equal(reconciled.divergent, true);
    assert.equal(reconciled.refsVerified, false);
  }
});

test("authoritative orchestrator FAB pair is retained and neutral in every party rate", () => {
  const result = reconcileCurrentCopies(deal, parties[1].primaryClaim, graph(bundle("buyer", "failed-counterparty", "orchestrator")), graph(bundle("seller", "failed-counterparty", "orchestrator")));
  assert.equal(result.refsVerified, true);
  assert.equal(result.orchestratorFaultNeutral, true);
  const record: DealRecord = { ...deal, signatureVerified: true, refsVerified: result.refsVerified, reputationEligible: true,
    sellerOutcome: result.sellerOutcome, orchestratorFaultNeutral: result.orchestratorFaultNeutral, finalisedAt: 10, verifiedAt: 10 };
  const reputation = deriveSellerReputation([record], 0, 100);
  assert.equal(reputation.bundleCount, 1);
  assert.deepEqual([reputation.completionRate, reputation.counterpartyFaultRate, reputation.counterpartyAdjustedCompletionRate], [null, null, null]);
});

test("native settlement verifies terminal inclusion, native payload, endpoints and exact OS amount", async () => {
  const hash = "ab".repeat(32), payer = `0x${"1".repeat(64)}`, payee = `0x${"2".repeat(64)}`;
  const agreement = { agreementVersion: "1", parties, terms: { price: { amount: "1.25", currency: "DEM" } } };
  const ref = { txHash: hash, blockNumber: 7 };
  const tx = { hash, status: "confirmed", blockNumber: 7, content: { type: "native", from: payer, to: payee, amount: "1250000000", data: ["native", { nativeOperation: "send", args: [payee, "1250000000"] }] } };
  const block = { number: 7, content: { ordered_transactions: [hash] } };
  const check = (changedTx: unknown = tx, changedBlock: unknown = block, changedRef = ref, changedAgreement = agreement) => verifyNativePayment(changedRef, changedAgreement, 2, async (m) => m === "getTxByHash" ? changedTx : changedBlock);
  assert.equal(await check(), "pass");
  assert.equal(await check(null), "indeterminate");
  assert.equal(await check({ ...tx, status: "pending" }), "indeterminate");
  for (const changed of [{ ...tx, status: "failed" }, { ...tx, blockNumber: 8 }, { ...tx, hash: "c".repeat(64) },
    ...[{ to: payer }, { from: payee }, { amount: "1" }, { type: "storageProgram" }, { data: ["native", { nativeOperation: "send", args: [payer, "1250000000"] }] }, { data: ["native", { nativeOperation: "send", args: [payee, "1"] }] }].map((change) => ({ ...tx, content: { ...tx.content, ...change } }))]) assert.equal(await check(changed), "fail");
  assert.equal(await check(tx, { ...block, content: { ordered_transactions: [] } }), "fail");
  assert.equal(await check(tx, { ...block, number: 8 }), "fail");
  assert.equal(await check(tx, null), "indeterminate");
  assert.equal(await verifyNativePayment(ref, agreement, 2), "indeterminate");
  assert.equal(await check(tx, block, { ...ref, blockNumber: undefined } as never), "fail");
  assert.equal(demOs("0.000000001"), 1n);
  assert.equal(demOs("1.0000000001"), null);
  assert.equal(demOs("1e9"), null);
});


test("historical signed rail aliases are excluded from current public discovery", () => {
  const listings = ["pay-dem", "pay-x402", "demos-native:DEM", "x402:default"].map((rail) => ({ listingId: rail, artifactProfile: "dacs-v0.1", status: "active", offering: { rails: [rail] } }));
  const sellers = [{ listings }] as unknown as SellerRecord[];
  assert.deepEqual(activeCatalogSellers(sellers)[0].listings.map((l) => l.listingId), ["demos-native:DEM", "x402:default"]);
  assert.deepEqual(activeCatalogListings({ sellers } as Catalog).map((l) => l.listingId), ["demos-native:DEM", "x402:default"]);
  assert.deepEqual(activeCatalogSellers([{ listings: listings.slice(0, 2) }] as unknown as SellerRecord[]), []);
});
