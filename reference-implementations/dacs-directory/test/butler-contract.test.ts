import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentInputError,
  ButlerContractError,
  PROCUREMENT_TIMEOUT_MESSAGE,
  fetchJsonBeforeDeadline,
  parseAgentCatalog,
  parseAgentInput,
  parseButlerRun,
  parseProcurementJob,
  parseReceiptEnvelope,
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
  // mode/input are optional gateway schema fields, passed through (undefined
  // when the catalog does not publish them).
  assert.deepEqual(parseAgentCatalog({ agents: [agent] }), [{ ...agent, mode: undefined, input: undefined }]);
  const withSchema = { ...agent, mode: "sync", input: [{ name: "url", type: "string", required: true }] };
  const parsed = parseAgentCatalog({ agents: [withSchema] })[0];
  assert.equal(parsed.mode, "sync");
  assert.deepEqual(parsed.input, withSchema.input);
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

test("parses the asynchronous output receipt lifecycle without hiding the agent result", () => {
  const outputAttestation = {
    receiptId: "receipt-1",
    statusUrl: "/demo/butler/receipts/receipt-1",
    status: "queued",
    attempts: 1,
    createdAt: "2026-07-16T08:00:00.000Z",
    updatedAt: "2026-07-16T08:00:00.000Z",
    digest: "abc123",
    anchorAddress: "stor-abc123",
    note: "queued for nonce-safe anchoring",
  } as const;
  const run = parseButlerRun({
    butler: { selectedAgent: "evalbot", label: "EvalBot" },
    result: { accepted: true },
    execution: { requestId: "request-1", durationMs: 1_800 },
    outputAttestation,
  });
  assert.deepEqual(run.result, { accepted: true });
  assert.equal(run.execution?.durationMs, 1_800);
  assert.equal(run.outputAttestation?.status, "queued");

  assert.equal(parseReceiptEnvelope({ outputAttestation: { ...outputAttestation, status: "confirmed", txRef: "tx-1" } }).txRef, "tx-1");
  assert.throws(
    () => parseReceiptEnvelope({ outputAttestation: { ...outputAttestation, status: "mystery" } }),
    ButlerContractError,
  );
});

test("only accepts JSON objects as editable agent input", () => {
  assert.deepEqual(parseAgentInput({ budgetDem: 5 }), { budgetDem: 5 });
  for (const value of [null, [], "text", 5, true]) {
    assert.throws(() => parseAgentInput(value), AgentInputError);
  }
});

test("aborts a procurement request and body read when its deadline expires", async () => {
  let signalWasAborted = false;
  const hangingFetch: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      signalWasAborted = true;
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
  await assert.rejects(
    fetchJsonBeforeDeadline("https://agents.example/demo/procurement", undefined, Date.now() + 20, hangingFetch),
    new RegExp(PROCUREMENT_TIMEOUT_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.equal(signalWasAborted, true);

  let called = false;
  await assert.rejects(
    fetchJsonBeforeDeadline("https://agents.example/demo/procurement", undefined, Date.now() - 1, async () => {
      called = true;
      return new Response();
    }),
    new RegExp(PROCUREMENT_TIMEOUT_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.equal(called, false);

  const headersFirstFetch: typeof fetch = async (_input, init) => ({
    json: async () => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  }) as Response;
  await assert.rejects(
    fetchJsonBeforeDeadline("https://agents.example/demo/procurement/job-1", undefined, Date.now() + 20, headersFirstFetch),
    new RegExp(PROCUREMENT_TIMEOUT_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("propagates an explicit browser cancellation into a bounded request", async () => {
  const browser = new AbortController();
  const hangingFetch: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  const request = fetchJsonBeforeDeadline(
    "https://agents.example/demo/butler",
    { signal: browser.signal },
    Date.now() + 10_000,
    hangingFetch,
  );
  browser.abort();
  await assert.rejects(request, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
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

  assert.equal(procurementEvidence({
    ...acceptedReport,
    negotiation: { ...acceptedReport.negotiation, buyerSignature: undefined, sellerSignature: undefined },
  }).overallAccepted, false, "both negotiation signatures are required for acceptance");

  // Structured shape observed from the live gateway (2026-07-17):
  // { party, algorithm, value } records instead of bare signature strings.
  assert.equal(procurementEvidence({
    ...acceptedReport,
    negotiation: {
      ...acceptedReport.negotiation,
      buyerSignature: { party: "did:demos:agent:buyer", algorithm: "ed25519", value: "buyer-sig-bytes" },
      sellerSignature: { party: "did:demos:agent:seller", algorithm: "ed25519", value: "seller-sig-bytes" },
    },
  }).overallAccepted, true, "structured { party, algorithm, value } signatures count as present");

  assert.equal(procurementEvidence({
    ...acceptedReport,
    negotiation: {
      ...acceptedReport.negotiation,
      buyerSignature: { party: "did:demos:agent:buyer", algorithm: "ed25519", value: "  " },
      sellerSignature: { party: "did:demos:agent:seller", algorithm: "ed25519", value: "seller-sig-bytes" },
    },
  }).overallAccepted, false, "a structured signature with a blank value is still missing");
});

test("synchronous LIVE-ANCHOR attestations parse without polling fields", () => {
  // Exact shape observed from the live gateway (2026-07-16): no receiptId,
  // statusUrl, attempts, or timestamps — evidence is final in the response.
  const run = parseButlerRun({
    butler: { selectedAgent: "site-auditor", label: "Site Auditor" },
    result: { ok: true },
    execution: { requestId: "r-1", durationMs: 1200 },
    outputAttestation: {
      scheme: "LIVE-ANCHOR-storage",
      digest: "ee2c3f4063c12d4c675ecd1ce00580d550162d70d31bab08211e0b020bbcbf96",
      anchorName: "dacs:out:site-auditor:152d9787-006a-4577-8350-b0d1c86f6bc4",
      anchorAddress: "stor-fe71b82554c98045d0682069bcf6b85e83663703",
      txRef: "9c01292740a6f510ce190accd831259a83fab8582e227afff951c0670d093701",
      committedBy: "0xbe3a1915bf109b55243c00e4b9ec92014f82d2b7faeccac8f66df7af05f7329c",
      status: "broadcast",
      note: "The result digest was broadcast to Demos StorageProgram.",
    },
  });
  assert.equal(run.outputAttestation?.status, "broadcast");
  assert.equal(run.outputAttestation?.statusUrl, undefined);
  assert.equal(run.outputAttestation?.scheme, "LIVE-ANCHOR-storage");
  assert.ok(run.outputAttestation?.txRef);
  // Digest/anchor/note remain mandatory in both shapes.
  assert.throws(() => parseButlerRun({
    butler: { selectedAgent: "x", label: "X" }, result: {},
    outputAttestation: { status: "broadcast", note: "n" },
  }));
});
