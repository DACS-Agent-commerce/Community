import assert from "node:assert/strict";
import test from "node:test";
import {
  ButlerContractError,
  parseAgentCatalog,
  parseButlerRun,
  parseProcurementJob,
  procurementEvidence,
} from "../src/components/try-dacs-contract.js";

const agent = {
  name: "procurement-butler",
  label: "Procurement Butler",
  summary: "Runs the full DACS purchase lifecycle.",
  tags: ["procure", "audit"],
  exampleGoal: "Procure a bounded security audit.",
  exampleInput: { budgetDem: 5 },
};

const acceptedReport = {
  status: "settled-and-accepted",
  settlement: { txHash: "payment-tx" },
  negotiation: { buyerSignature: "buyer-signature", sellerSignature: "seller-signature" },
  delivery: { verified: true, report: { findings: [] } },
  evaluation: { ruling: { verdict: "accept" }, rulingValid: true, accepted: true },
  bundleVerification: { ok: true },
  reconciliation: { reconciled: true },
  transactions: [{ kind: "payment", txRef: "payment-tx" }],
};

test("accepts the published Butler catalog contract", () => {
  assert.deepEqual(parseAgentCatalog({ agents: [agent] }), [agent]);
});

test("rejects catalog drift instead of rendering invented fallbacks", () => {
  assert.throws(
    () => parseAgentCatalog({ agents: [{ ...agent, exampleGoal: undefined }] }),
    (error: unknown) => error instanceof ButlerContractError && /exampleGoal/.test(error.message),
  );
  assert.throws(() => parseAgentCatalog({ agents: [] }), ButlerContractError);
});

test("accepts running and completed procurement envelopes", () => {
  const running = parseProcurementJob({
    id: "job-1",
    status: "running",
    phase: "settling",
    events: [{ phase: "settling", label: "Payment broadcast", at: "2026-07-16T08:00:00.000Z", txRef: "payment-tx" }],
  });
  assert.equal(running.events[0]?.txRef, "payment-tx");

  const complete = parseProcurementJob({ ...running, status: "complete", phase: "complete", result: acceptedReport });
  assert.equal(complete.result, acceptedReport);
});

test("rejects malformed procurement and general Butler responses", () => {
  assert.throws(
    () => parseProcurementJob({ id: "job-1", status: "done", phase: "complete", events: [] }),
    ButlerContractError,
  );
  assert.throws(
    () => parseProcurementJob({ id: "job-1", status: "complete", phase: "complete", events: [], result: undefined }),
    ButlerContractError,
  );
  assert.throws(
    () => parseButlerRun({ butler: { selectedAgent: "sec-audit", label: "Security Auditor" } }),
    ButlerContractError,
  );
  assert.equal(
    parseButlerRun({ butler: { selectedAgent: "sec-audit", label: "Security Auditor" }, result: { findings: [] } }).result !== undefined,
    true,
  );
});

test("only reports acceptance when every explicit verification signal is present", () => {
  assert.deepEqual(procurementEvidence(acceptedReport), {
    statusAccepted: true,
    paymentRecorded: true,
    negotiationSigned: true,
    deliveryVerified: true,
    bundlesVerified: true,
    reconciled: true,
    rulingValid: true,
    rulingAccepted: true,
    overallAccepted: true,
  });

  assert.deepEqual(procurementEvidence({ status: "settled-and-accepted" }), {
    statusAccepted: true,
    paymentRecorded: false,
    negotiationSigned: false,
    deliveryVerified: false,
    bundlesVerified: false,
    reconciled: false,
    rulingValid: false,
    rulingAccepted: false,
    overallAccepted: false,
  });

  assert.equal(procurementEvidence({
    ...acceptedReport,
    settlement: { txHash: "different-tx" },
  }).overallAccepted, false, "the payment hash must also appear in the transaction receipts");
});
