import assert from "node:assert/strict";
import test from "node:test";

import { ProcurementLockUnavailableError, parseStoredProcurementRun, resumeDispatchDecision, stageEvents, withExclusiveProcurementLock, type LockRequestor, type StoredProcurementRun } from "../src/components/try-dacs-stages.js";
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

test("label overrides apply to recognised phases only — an unknown phase cannot spoof progress", () => {
  const { byStage, progress } = stageEvents([
    event("queued", "Full DACS purchase queued"),
    event("mystery-phase", "Preparing the RFQ agreement paperwork"),
  ]);
  assert.equal(progress, 0, "keyword-bearing labels on unrecognised phases must not advance progress");
  assert.equal(byStage[0]!.length, 2);
  assert.equal(byStage[2]!.length, 0);
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

/**
 * A faithful in-process stand-in for the Web Locks manager: exclusive FIFO
 * grants, and a request whose signal is already aborted at grant time
 * rejects without ever invoking its callback.
 */
function fakeLockManager(): LockRequestor {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    request(_name, options, callback) {
      const run = tail.then(() => {
        if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
        return callback();
      });
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}

test("paid dispatch REFUSES to run without a real lock manager", async () => {
  let sectionRan = false;
  await assert.rejects(
    withExclusiveProcurementLock(undefined, new AbortController().signal, async () => { sectionRan = true; }),
    ProcurementLockUnavailableError,
  );
  assert.equal(sectionRan, false, "the section must never execute without mutual exclusion");
});

test("the lock serializes two dispatch sections and propagates results", async () => {
  const locks = fakeLockManager();
  const order: string[] = [];
  const signal = new AbortController().signal;
  const first = withExclusiveProcurementLock(locks, signal, async () => {
    order.push("a-start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("a-end");
    return "A";
  });
  const second = withExclusiveProcurementLock(locks, signal, async () => {
    order.push("b-start");
    return "B";
  });
  assert.deepEqual(await Promise.all([first, second]), ["A", "B"]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start"], "the second section must wait for the first");
});

test("aborting while waiting for the lock rejects and never runs the section", async () => {
  const locks = fakeLockManager();
  let release!: () => void;
  const holder = withExclusiveProcurementLock(locks, new AbortController().signal, () =>
    new Promise<void>((resolve) => { release = resolve; }));
  const cancelled = new AbortController();
  let lateSectionRan = false;
  const waiting = withExclusiveProcurementLock(locks, cancelled.signal, async () => { lateSectionRan = true; });
  await new Promise((resolve) => setTimeout(resolve, 0)); // let the holder's section start and assign release
  cancelled.abort();
  release();
  await holder;
  await assert.rejects(waiting, (error: unknown) => (error as Error).name === "AbortError");
  assert.equal(lateSectionRan, false, "a cancelled tab must never execute its section after the wait");
});

test("resume decisions: stale records abort, known job ids read, only the raced case posts", () => {
  const captured: StoredProcurementRun = { runId: "run-x", goal: "g", input: { budgetDem: 5 }, startedAt: at };
  assert.deepEqual(resumeDispatchDecision(captured, null), { action: "abort-stale" });
  assert.deepEqual(resumeDispatchDecision(captured, { ...captured, runId: "run-y" }), { action: "abort-stale" });
  assert.deepEqual(resumeDispatchDecision(captured, { ...captured, jobId: "job-1" }), { action: "read", jobId: "job-1" });
  assert.deepEqual(resumeDispatchDecision(captured, { ...captured }), { action: "post" });
});

test("a stale resume queued behind a newer run neither posts nor touches the newer record", async () => {
  const locks = fakeLockManager();
  const signal = new AbortController().signal;
  // Shared storage stand-in: starts holding run X (tab A's capture).
  const runX: StoredProcurementRun = { runId: "run-x", goal: "old goal", input: { budgetDem: 5 }, startedAt: at };
  const runY: StoredProcurementRun = { runId: "run-y", jobId: "job-y", goal: "new goal", input: { budgetDem: 3 }, startedAt: at };
  let storage: string | null = JSON.stringify(runX);
  const capturedByA = JSON.parse(storage) as StoredProcurementRun;

  // Tab B holds the lock first: dismisses X and starts run Y (writes Y).
  const tabB = withExclusiveProcurementLock(locks, signal, async () => {
    storage = null;                    // user dismissed X
    storage = JSON.stringify(runY);    // B dispatched a new purchase
  });
  // Tab A's resume of X is QUEUED behind B — the reviewer's exact sequence.
  let aPosted = false;
  const tabA = withExclusiveProcurementLock(locks, signal, async () => {
    const decision = resumeDispatchDecision(capturedByA, parseStoredProcurementRun(storage));
    if (decision.action === "post") {
      aPosted = true;                  // would re-POST X and overwrite Y
      storage = JSON.stringify({ ...capturedByA, jobId: "job-x" });
    }
    return decision;
  });

  await tabB;
  const decision = await tabA;
  assert.deepEqual(decision, { action: "abort-stale" }, "A must refuse once its captured record is superseded");
  assert.equal(aPosted, false, "the stale section must never dispatch");
  assert.equal(storage, JSON.stringify(runY), "run Y's recovery record must remain byte-identical");
});

test("a same-run resume queued behind the job-id write reads instead of re-posting", async () => {
  const locks = fakeLockManager();
  const signal = new AbortController().signal;
  const runX: StoredProcurementRun = { runId: "run-x", goal: "g", input: { budgetDem: 5 }, startedAt: at };
  let storage: string | null = JSON.stringify(runX);
  const captured = JSON.parse(storage) as StoredProcurementRun;

  // Another tab of the SAME run learned the job id while this resume queued.
  const other = withExclusiveProcurementLock(locks, signal, async () => {
    storage = JSON.stringify({ ...runX, jobId: "job-x" });
  });
  const resume = withExclusiveProcurementLock(locks, signal, async () =>
    resumeDispatchDecision(captured, parseStoredProcurementRun(storage)));

  await other;
  assert.deepEqual(await resume, { action: "read", jobId: "job-x" }, "a known job id must be read, never re-POSTed");
});
