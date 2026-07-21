import assert from "node:assert/strict";
import test from "node:test";

import {
  SAMPLE_PROCUREMENT_EVENTS,
  describeEvent,
  eventsToConversation,
} from "../src/components/try-chat-script.js";
import type { ProcurementEvent } from "../src/components/try-dacs-contract.js";

test("the sample deal folds into a two-agent conversation across all five stages", () => {
  const turns = eventsToConversation(SAMPLE_PROCUREMENT_EVENTS);
  assert.equal(turns.length, SAMPLE_PROCUREMENT_EVENTS.length);
  // Every DACS stage 0..4 is represented.
  assert.deepEqual([...new Set(turns.map((t) => t.stage))].sort(), [0, 1, 2, 3, 4]);
  // Both agents speak, the chain records, and the referee judges.
  const speakers = new Set(turns.map((t) => t.speaker));
  for (const who of ["butler", "seller", "chain", "referee"]) assert.ok(speakers.has(who as never), `${who} appears`);
  // Progress only advances — a stage index never goes backwards.
  for (let i = 1; i < turns.length; i++) assert.ok(turns[i]!.stage >= turns[i - 1]!.stage);
});

test("anchored events become chain receipts carrying their real tx/anchor refs", () => {
  const turns = eventsToConversation(SAMPLE_PROCUREMENT_EVENTS);
  const payment = turns.find((t) => t.raw === "Payment broadcast on Demos");
  assert.ok(payment);
  assert.equal(payment!.speaker, "chain");
  assert.equal(payment!.kind, "pay");
  assert.equal(payment!.txRef, "53dd8a7b34f7d29377c27599e17a5742b2c7296dd048b1235c04359957e0ff24");

  const vet = turns.find((t) => t.raw === "Identity Vet record anchored");
  assert.equal(vet!.speaker, "chain");
  assert.equal(vet!.kind, "anchor");
  assert.ok(vet!.anchorRef?.startsWith("stor-"));
});

test("every turn preserves the exact gateway label as evidence", () => {
  const turns = eventsToConversation(SAMPLE_PROCUREMENT_EVENTS);
  turns.forEach((turn, i) => assert.equal(turn.raw, SAMPLE_PROCUREMENT_EVENTS[i]!.label));
});

test("the payment line is attributed to the Butler and quotes the negotiated amount", () => {
  const pay = eventsToConversation(SAMPLE_PROCUREMENT_EVENTS).find((t) => /Paying/.test(t.raw));
  assert.ok(pay);
  assert.equal(pay!.speaker, "butler");
  assert.equal(pay!.kind, "pay");
  assert.match(pay!.text, /2\.35 DEM/);
});

test("an unknown label is attributed honestly, never invented as dialogue", () => {
  const event: ProcurementEvent = { phase: "connecting", label: "Some brand-new gateway milestone", at: "t" };
  const d = describeEvent(event, 0);
  assert.equal(d.speaker, "butler");
  assert.equal(d.text, "Some brand-new gateway milestone");
});

test("a failed event fails closed: attributed to Butler, keeps the running stage, never a chain receipt", () => {
  const event: ProcurementEvent = { phase: "failed", label: "Stopped safely: node lag", at: "t" };
  const d = describeEvent(event, 2);
  assert.equal(d.speaker, "butler");
  assert.equal(d.stage, 2);
  assert.match(d.text, /Stopped safely/);
});
