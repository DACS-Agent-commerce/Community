import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isCanonicalSettlementTxId, settlementTxId } from "../src/catalog/settlementUniqueness.js";

test("pinned SB-1 current-arm pass vectors produce the exact upstream settlement ID", () => {
  const bytes = readFileSync(new URL("./fixtures/dacs-standard/settlement-event-identity-v0.6.json", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "397b44a02f0c7b4ae629e8c15155d665df1b8c706ccdc516b38c706dba4d1ed4",
    "the fixture must remain byte-identical to DACS-Standard d45c0a29");
  const set = JSON.parse(bytes.toString("utf8"));
  assert.equal(set.vectors.length, set.count);
  const currentArms = new Set(["demos", "evm-event", "x402-event", "solana-instruction"]);
  const selected = set.vectors.filter((vector: { expected: string; settlementEvidence: { paymentTxRefs: Array<{ kind: string }> } }) =>
    vector.expected === "pass" && vector.settlementEvidence.paymentTxRefs.every((ref) => currentArms.has(ref.kind)));
  assert.deepEqual(selected.map((vector: { name: string }) => vector.name), [
    "current-evm-log-index", "current-solana-instruction-index", "batched-evm-transfer-distinct-key",
    "current-x402-event", "payment-anchor-cf4-encoded-rail",
  ]);
  // These assertions cover identity spelling only. Ledger-event and anchor
  // verification require independent authority and are outside this projection.
  for (const vector of selected) {
    assert.deepEqual(vector.settlementEvidence.paymentTxRefs.map(settlementTxId), [vector.expectedSettlementTxId], vector.name);
    assert.equal(isCanonicalSettlementTxId(vector.expectedSettlementTxId), true, vector.name);
  }
});
