import assert from "node:assert/strict";
import test from "node:test";

import { parseStoredProcurementRun, stageEvents } from "../src/components/try-dacs-stages.js";
import type { ProcurementEvent } from "../src/components/try-dacs-contract.js";

const at = "2026-07-17T16:58:00.000Z";
const event = (phase: string, label: string, txRef?: string): ProcurementEvent => ({ phase, label, at, ...(txRef ? { txRef } : {}) });

// The full event stream captured verbatim from a live accepted purchase
// (butler.agentcommerce.network, 2026-07-17).
const LIVE_RUN: ProcurementEvent[] = [
  event("queued", "Full DACS purchase queued"),
  event("connecting", "Connecting the Butler buyer wallet and live L2PS transport"),
  event("discovering", "Resolving the indexed Auditor's signed DACS-1 listing from chain"),
  event("discovering", "Verified the Auditor listing advertised by the indexer"),
  event("selecting", "Butler scoring the verified listing against budget, capability, quality and rail"),
  event("selecting", "Butler opened a signed RFQ channel with dacs-auditor"),
  event("selecting", "Identity Vet record anchored", "tx-vet"),
  event("selecting", "Buyer/seller agreement anchored", "tx-agreement"),
  event("selecting", "Commitment anchored before payment", "tx-commit"),
  event("agreeing", "Buyer and Auditor agreed quick/standard at 1.9 DEM"),
  event("agreeing", "Dual-signed agreement and commitment anchored before payment"),
  event("settling", "Paying 1.9 DEM to the negotiated Auditor"),
  event("settling", "Payment broadcast on Demos", "tx-payment"),
  event("delivering", "Auditor verified payment and is scanning the posted source"),
  event("delivering", "Auditor signed and anchored the content-bound report"),
  event("verifying", "Buyer anchoring payment evidence and requesting the Auditor's bundle signature"),
  event("verifying", "Settlement evidence anchored", "tx-evidence"),
  event("verifying", "Buyer attestation bundle anchored", "tx-bundle"),
  event("evaluating", "EvalBot applying and signing the acceptance rubric"),
  event("complete", "Purchase settled, report delivered, and full DACS bundle verified"),
];

test("a full live run maps events onto their DACS stages and reaches Verify", () => {
  const { byStage, progress } = stageEvents(LIVE_RUN);
  assert.equal(progress, 4);
  // Identify: queue/connect/discover.
  assert.deepEqual(byStage[0]!.map((e) => e.label.slice(0, 20)), [
    "Full DACS purchase q", "Connecting the Butle", "Resolving the indexe", "Verified the Auditor",
  ]);
  // Vet: the scoring event plus the anchored vet record.
  assert.ok(byStage[1]!.some((e) => e.label === "Identity Vet record anchored"));
  // Negotiate: RFQ + agreement + commitment, including those emitted while
  // the job phase was still "selecting".
  assert.ok(byStage[2]!.some((e) => e.label === "Buyer/seller agreement anchored"));
  assert.ok(byStage[2]!.some((e) => e.label === "Commitment anchored before payment"));
  assert.ok(byStage[2]!.some((e) => e.label === "Butler opened a signed RFQ channel with dacs-auditor"));
  // Settle & deliver: payment + delivery + the settlement-evidence anchor
  // that arrives under the "verifying" phase.
  assert.ok(byStage[3]!.some((e) => e.label === "Payment broadcast on Demos"));
  assert.ok(byStage[3]!.some((e) => e.label === "Settlement evidence anchored"));
  // Verify: bundle + evaluation + completion.
  assert.ok(byStage[4]!.some((e) => e.label === "Buyer attestation bundle anchored"));
  assert.ok(byStage[4]!.some((e) => e.label.startsWith("Purchase settled")));
});

test("an early failure never advances progress or completes later stages", () => {
  const { byStage, progress } = stageEvents([
    event("queued", "Full DACS purchase queued"),
    event("connecting", "Connecting the Butler buyer wallet and live L2PS transport"),
    event("failed", "Stopped safely: procurement buyer needs at least 8 DEM for payment and DACS anchors"),
  ]);
  assert.equal(progress, 0, "a terminal failure during connecting must leave progress at Identify");
  assert.equal(byStage[0]!.length, 3, "the failure event attaches to the stage the run had reached");
  assert.deepEqual(byStage.slice(1).map((events) => events.length), [0, 0, 0, 0]);
});

test("a failure message mentioning a later stage cannot fake its progress", () => {
  const { byStage, progress } = stageEvents([
    event("queued", "Full DACS purchase queued"),
    event("failed", "Stopped safely: could not anchor the agreement before payment"),
  ]);
  assert.equal(progress, 0, "failed events are never label-matched into a stage");
  assert.equal(byStage[0]!.length, 2);
  assert.equal(byStage[2]!.length, 0);
});

test("an unknown non-terminal phase attaches to current progress without advancing it", () => {
  const { byStage, progress } = stageEvents([
    event("queued", "Full DACS purchase queued"),
    event("selecting", "Butler scoring the verified listing"),
    event("some-new-phase", "A future gateway milestone"),
  ]);
  assert.equal(progress, 1);
  assert.ok(byStage[1]!.some((e) => e.label === "A future gateway milestone"));
});

test("a failure after payment keeps progress at Settle with the payment evidence", () => {
  const { byStage, progress } = stageEvents([
    event("queued", "Full DACS purchase queued"),
    event("selecting", "Identity Vet record anchored", "tx-vet"),
    event("agreeing", "Buyer and Auditor agreed quick/standard at 1.9 DEM"),
    event("settling", "Payment broadcast on Demos", "tx-payment"),
    event("failed", "Stopped safely: gateway restarted before the run completed"),
  ]);
  assert.equal(progress, 3);
  assert.ok(byStage[3]!.some((e) => e.txRef === "tx-payment"));
  assert.ok(byStage[3]!.some((e) => e.phase === "failed"), "the failure lands on the stage that was live");
  assert.equal(byStage[4]!.length, 0, "Verify must not appear started");
});

test("stored procurement run records round-trip and reject malformed shapes", () => {
  const run = { runId: "0e9f2c34-3d1a-4a11-b7d0-1f2a3b4c5d6e", jobId: "job-1", goal: "g", input: { budgetDem: 5 }, startedAt: at };
  assert.deepEqual(parseStoredProcurementRun(JSON.stringify(run)), run);
  const noJob = { runId: run.runId, goal: "g", input: {}, startedAt: at };
  assert.deepEqual(parseStoredProcurementRun(JSON.stringify(noJob)), { ...noJob, jobId: undefined });
  assert.equal(parseStoredProcurementRun(null), null);
  assert.equal(parseStoredProcurementRun("not json"), null);
  assert.equal(parseStoredProcurementRun(JSON.stringify({ runId: "  ", goal: "g", input: {}, startedAt: at })), null);
  assert.equal(parseStoredProcurementRun(JSON.stringify({ goal: "g", input: {}, startedAt: at })), null);
  assert.equal(parseStoredProcurementRun(JSON.stringify({ runId: "r", goal: "g", input: [], startedAt: at })), null);
  assert.equal(parseStoredProcurementRun(JSON.stringify({ runId: "r", goal: "g", input: {}, startedAt: at, jobId: 7 })), null);
  assert.equal(parseStoredProcurementRun(JSON.stringify(["runId"])), null);
});
