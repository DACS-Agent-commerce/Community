"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_TIMEOUT_MESSAGE,
  ButlerContractError,
  fetchJsonBeforeDeadline,
  fetchJsonWithTimeout,
  parseAgentCatalog,
  parseAgentInput,
  parseButlerRun,
  parseProcurementJob,
  parseReceiptEnvelope,
  procurementEvidence,
  record,
  type AgentCard,
  type OutputReceipt,
  type ProcurementEvent,
  type ProcurementJob,
} from "./try-dacs-contract.js";
import {
  flattenInputKeys,
  hasBuiltinForm,
  initialAgentInput,
  mapGatewayErrors,
  initialSchemaInput,
  parseAgentFieldSchema,
  summarizeAgentInput,
  validateAgentInput,
  validateSchemaInput,
  type FieldErrors,
} from "./try-dacs-forms.js";
import AgentInputForm from "./try-forms/AgentInputForm.js";
import { parseStoredProcurementRun, stageEvents, type StoredProcurementRun } from "./try-dacs-stages.js";

const BUTLER = (process.env.NEXT_PUBLIC_BUTLER_ORIGIN ?? "http://127.0.0.1:8402").replace(/\/$/, "");
const PROCUREMENT_RUN_KEY = "dacs-try:procurement-run";

function readStoredRun(): StoredProcurementRun | null {
  try { return parseStoredProcurementRun(window.localStorage.getItem(PROCUREMENT_RUN_KEY)); } catch { return null; }
}
function writeStoredRun(run: StoredProcurementRun | null): void {
  try {
    if (run) window.localStorage.setItem(PROCUREMENT_RUN_KEY, JSON.stringify(run));
    else window.localStorage.removeItem(PROCUREMENT_RUN_KEY);
  } catch { /* storage unavailable — the in-memory key still covers this session */ }
}

type Plan = {
  butler: { selectedAgent: string; label: string; rationale: string; selectionEngine: string; alternatives: string[] };
  proposedInput: Record<string, unknown>;
  inputNote: string;
};

const EXPLORER = "https://explorer.demos.sh";
const AGENT_TIMEOUT_MS = 120_000;
const RECEIPT_WATCH_TIMEOUT_MS = 2 * 60_000;

function compact(value: unknown, head = 18, tail = 8): string {
  const text = String(value ?? "");
  return text.length > head + tail + 1 ? `${text.slice(0, head)}…${text.slice(-tail)}` : text;
}

function elapsedLabel(ms: number): string {
  return ms < 10_000 ? `${(ms / 1_000).toFixed(1)}s` : `${Math.floor(ms / 1_000)}s`;
}

function waitWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
    const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener("abort", aborted); resolve(); }
    function aborted() { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function ProcurementReport({ value, events }: { value: unknown; events: ProcurementEvent[] }) {
  const report = record(value);
  const evidence = procurementEvidence(report);
  const decision = record(report.decision);
  const winner = record(decision.winner);
  const settlement = record(report.settlement);
  const negotiation = record(report.negotiation);
  const terms = record(negotiation.terms);
  const delivery = record(report.delivery);
  const audit = record(delivery.report);
  const evaluation = record(report.evaluation);
  const ruling = record(evaluation.ruling);
  const anchors = record(report.anchors);
  const candidates = Array.isArray(decision.candidates) ? decision.candidates.map(record) : [];
  const findings = Array.isArray(audit.findings) ? audit.findings.map(record) : [];
  const transactions = Array.isArray(report.transactions) ? report.transactions.map(record) : [];
  const paymentHash = String(settlement.txHash ?? "");
  const acceptedClass = evidence.overallAccepted ? "success-text" : "error-text";
  const acceptanceLabel = evidence.overallAccepted ? "Settled & accepted" : "Verification incomplete";
  const verificationLabel = evidence.overallAccepted ? "accepted" : "not accepted";
  const evaluationLabel = evidence.rulingAccepted && evidence.rulingValid
    ? "accept · signature valid"
    : `${String(ruling.verdict ?? "not reported")} · ${evidence.rulingValid ? "signature valid" : "signature unverified"}`;

  function check(label: string, detail: string, ok: boolean) {
    return <div className={ok ? "" : "failed-check"}><i>{ok ? "✓" : "!"}</i><span>{label}<strong>{detail}</strong></span></div>;
  }

  return (
    <div className="proc-report">
      <div className="proc-summary">
        <div><span>OUTCOME</span><strong className={acceptedClass}>{acceptanceLabel}</strong></div>
        <div><span>SELECTED SELLER</span><strong>{String(winner.provider ?? "not reported")}</strong></div>
        <div><span>PRICE</span><strong>{String(settlement.amountDem ?? settlement.amount ?? winner.price ?? "not reported")}{settlement.amountDem !== undefined || settlement.amount !== undefined || winner.price !== undefined ? " DEM" : ""}</strong></div>
        <div><span>PAYMENT RAIL</span><strong>{String(settlement.rail ?? "not reported")}</strong></div>
      </div>

      <section className={`proc-panel payment-panel ${evidence.paymentRecorded ? "" : "unverified-panel"}`}>
        <div className="proc-panel-head"><div><span>REAL PAYMENT</span><h3>Demos settlement transaction</h3></div><span className={`badge ${evidence.paymentRecorded ? "ok" : "err"}`}>{evidence.paymentRecorded ? "broadcast & recorded" : "evidence missing"}</span></div>
        {paymentHash ? <a className="tx-link" href={`${EXPLORER}/tx/${paymentHash}`} target="_blank" rel="noreferrer">
          <span><small>PAYMENT TX</small><code>{paymentHash}</code></span><b>View on explorer ↗</b>
        </a> : <div className="tx-link missing-evidence"><span><small>PAYMENT TX</small><code>not reported</code></span></div>}
        <div className="party-row"><span>payer <code>{compact(settlement.payer)}</code></span><i>→</i><span>seller <code>{compact(settlement.payee)}</code></span></div>
      </section>

      <section className="proc-panel">
        <div className="proc-panel-head"><div><span>LIVE NEGOTIATION</span><h3>Buyer and Auditor agreement over L2PS</h3></div><span className={`badge ${evidence.negotiationSigned ? "ok" : "err"}`}>{evidence.negotiationSigned ? "dual-signed" : "signatures missing"}</span></div>
        <div className="verify-grid">
          {check("Protocol", String(negotiation.protocol ?? "not reported"), Boolean(negotiation.protocol))}
          {check("Audit tier", String(terms.tier ?? "not reported"), Boolean(terms.tier))}
          {check("Turnaround", String(terms.deadline ?? "not reported"), Boolean(terms.deadline))}
          {check("Agreed price", terms.price !== undefined || settlement.amountDem !== undefined ? `${String(terms.price ?? settlement.amountDem)} DEM` : "not reported", terms.price !== undefined || settlement.amountDem !== undefined)}
        </div>
        <details className="anchor-details"><summary>Signed negotiation transcript and agreement hash</summary><pre>{JSON.stringify(negotiation, null, 2)}</pre></details>
      </section>

      <section className="proc-panel">
        <div className="proc-panel-head"><div><span>PROCUREMENT REPORT</span><h3>Why this seller was selected</h3></div><span className={`badge ${decision.outcome ? "ok" : "err"}`}>{String(decision.outcome ?? "not reported")}</span></div>
        <div className="candidate-table">
          <div className="candidate-row candidate-head"><span>Provider</span><span>Price</span><span>Rail</span><span>Decision</span></div>
          {candidates.map((candidate, index) => <div className="candidate-row" key={`${candidate.listingId}-${index}`}><span><strong>{String(candidate.provider ?? "candidate")}</strong><small>{compact(candidate.listingId, 12, 6)}</small></span><span>{String(candidate.askPrice ?? "—")} DEM</span><span>{String(candidate.chosenRail ?? "—")}</span><span className={candidate.excluded ? "muted-text" : "success-text"}>{candidate.excluded ? String(candidate.excluded) : "selected ✓"}</span></div>)}
        </div>
      </section>

      <section className="proc-panel">
        <div className="proc-panel-head"><div><span>DELIVERED REPORT</span><h3>Security audit findings</h3></div><span className={`badge ${evidence.deliveryVerified ? "ok" : "err"}`}>{evidence.deliveryVerified ? `${findings.length} finding${findings.length === 1 ? "" : "s"} · verified` : "delivery unverified"}</span></div>
        {findings.length ? <div className="finding-list">{findings.map((finding, index) => <article key={`${finding.id}-${index}`}><span className={`severity ${String(finding.severity ?? "info").toLowerCase()}`}>{String(finding.severity ?? "info")}</span><div><strong>{String(finding.ruleId ?? finding.id ?? "Finding")}</strong><p>{String(finding.rationale ?? "Attested source finding")}</p><code>{String(finding.file ?? "file")}:{String(finding.line ?? "?")}</code></div></article>)}</div> : <p className="empty-report">{evidence.deliveryVerified ? "The verified report found no matching issues in the posted fixture." : "No verified security report was returned."}</p>}
      </section>

      <section className="proc-panel">
        <div className="proc-panel-head"><div><span>VERIFICATION</span><h3>Independent acceptance checks</h3></div><span className={`badge ${evidence.overallAccepted ? "ok" : "err"}`}>{verificationLabel}</span></div>
        <div className="verify-grid">
          {check("Delivery evidence", evidence.deliveryVerified ? "verified" : "unverified", evidence.deliveryVerified)}
          {check("Buyer + seller bundles", evidence.bundlesVerified ? "verified" : "unverified", evidence.bundlesVerified)}
          {check("Reconciliation", evidence.reconciled ? "reconciled" : "not reconciled", evidence.reconciled)}
          {check("EvalBot ruling", evaluationLabel, evidence.rulingAccepted && evidence.rulingValid)}
        </div>
      </section>

      <section className="proc-panel">
        <div className="proc-panel-head"><div><span>ON-CHAIN RECEIPTS</span><h3>Every DACS artifact and transaction</h3></div><span className={`badge ${transactions.length ? "ok" : "err"}`}>{transactions.length} records</span></div>
        <div className="receipt-list">{transactions.map((transaction, index) => {
          const txRef = String(transaction.txRef ?? "");
          const anchorRef = String(transaction.address ?? "");
          return <div className="receipt-row" key={`${txRef}-${anchorRef}-${index}`}><span className="receipt-index">{String(index + 1).padStart(2, "0")}</span><div><strong>{String(transaction.name ?? transaction.kind ?? "chain record")}</strong><small>{anchorRef ? `anchor ${compact(anchorRef, 22, 8)}` : "Demos payment"}</small></div>{txRef ? <a href={`${EXPLORER}/tx/${txRef}`} target="_blank" rel="noreferrer">{compact(txRef, 15, 7)} ↗</a> : <span className="muted-text">existing anchor</span>}</div>;
        })}</div>
        <details className="anchor-details"><summary>All anchor addresses</summary><pre>{JSON.stringify(anchors, null, 2)}</pre></details>
      </section>

      <details className="raw-result"><summary>Raw full-flow JSON</summary><pre>{JSON.stringify({ events, result: value }, null, 2)}</pre></details>
    </div>
  );
}

/**
 * The five DACS stages, in the standard's own words (see /how-it-works:
 * Identify → Vet → Negotiate → Settle → Verify, "one deal · five receipts").
 * `plain` is the novice explanation shown behind "What's happening here?".
 */
const DACS_STAGES = [
  {
    key: "identify", name: "Identify", primitive: "DACS-1",
    tagline: "Who offers the service? Signed listings only.",
    receipt: "a signed on-chain listing",
    plain: "Agents advertise what they offer. In full DACS that's a signed listing anchored on the Demos chain — like a business card that can't be forged. This demo's picker shows the live gateway's agent roster; the Procurement Butler run then resolves and verifies a real signed DACS-1 listing on-chain before dealing.",
  },
  {
    key: "vet", name: "Vet", primitive: "DACS-2",
    tagline: "Check the counterparty before committing.",
    receipt: "an anchored verification record",
    plain: "Before dealing with a stranger you check who they are. Here the buyer verifies the seller's identity and claims, and writes that check to the chain — so later everyone can see the vet actually happened.",
  },
  {
    key: "negotiate", name: "Negotiate", primitive: "DACS-3",
    tagline: "Fix price, scope and timing — both agents sign.",
    receipt: "a dual-signed agreement",
    plain: "The two agents agree the job: what will be done, by when, for how much. Both sign the same agreement, so neither can later claim different terms. That signed agreement is anchored before any money moves.",
  },
  {
    key: "settle", name: "Settle & deliver", primitive: "DACS-4",
    tagline: "Pay on the agreed rail; the work arrives with evidence.",
    receipt: "a payment transaction + delivery evidence",
    plain: "The buyer pays on the agreed payment rail (in the full purchase demo, real DEM moves on-chain) and the seller delivers the work. The payment hash and the delivered report are both captured as evidence.",
  },
  {
    key: "verify", name: "Verify", primitive: "DACS-5",
    tagline: "Bind every receipt into one bundle both sides anchor.",
    receipt: "a reconciled attestation bundle",
    plain: "Finally everything — listing, vet, agreement, payment and delivery — is tied into one signed bundle that both sides anchor. Anyone can re-run the checks later, and honest deals build the seller's public reputation.",
  },
] as const;

type StageOutput = {
  state: "pending" | "active" | "complete" | "warning" | "skipped";
  summary: string;
  detail?: string;
  /** Chain records produced by this stage, rendered as explorer links. */
  chain?: ProcurementEvent[];
};

function message(value: unknown): string {
  if (value && typeof value === "object" && "error" in value) {
    const error = (value as { error?: string | { message?: string } }).error;
    if (typeof error === "string" && error.trim()) return error;
    if (error && typeof error === "object" && error.message) return error.message;
  }
  return "The Butler could not complete that step.";
}

export default function TryDacs() {
  const [agents, setAgents] = useState<AgentCard[]>([]);
  const [goal, setGoal] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [inputValue, setInputValue] = useState<Record<string, unknown>>({});
  const [gatewayFieldErrors, setGatewayFieldErrors] = useState<FieldErrors>({});
  const [submittedSummary, setSubmittedSummary] = useState<string[]>([]);
  const [phase, setPhase] = useState<"idle" | "planning" | "ready" | "running" | "done" | "error">("idle");
  const [result, setResult] = useState<unknown>();
  const [procurementJob, setProcurementJob] = useState<ProcurementJob | null>(null);
  const [error, setError] = useState("");
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [receipt, setReceipt] = useState<OutputReceipt | null>(null);
  const [receiptPolling, setReceiptPolling] = useState(false);
  const [receiptMessage, setReceiptMessage] = useState("");
  const runAbort = useRef<AbortController | null>(null);
  const receiptAbort = useRef<AbortController | null>(null);
  const procurementJobRef = useRef<ProcurementJob | null>(null);
  // One idempotency key per intentional procurement run, reused across retries
  // of that run so the gateway returns the existing job instead of creating a
  // second paid one. Cleared when a new intent begins (new agent, edited input,
  // Load example) or on success.
  const procurementRunId = useRef<string | null>(null);

  useEffect(() => {
    fetch(`${BUTLER}/demo/butler/agents`)
      .then((res) => res.ok ? res.json() : Promise.reject(new Error("catalog unavailable")))
      .then((body: unknown) => setAgents(parseAgentCatalog(body)))
      .catch((cause: unknown) => setError(cause instanceof ButlerContractError
        ? cause.message
        : "The live agent network is temporarily unavailable."));
  }, []);

  useEffect(() => {
    if (!runStartedAt || (phase !== "running" && !receiptPolling)) return;
    const update = () => setElapsedMs(Date.now() - runStartedAt);
    update();
    const timer = setInterval(update, 100);
    return () => clearInterval(timer);
  }, [phase, receiptPolling, runStartedAt]);

  useEffect(() => { procurementJobRef.current = procurementJob; }, [procurementJob]);

  // The persisted procurement run (idempotency key + input + job id). Written
  // BEFORE the POST is dispatched so a reload/crash can never lose the key of
  // a purchase the gateway may have started; kept until the job reaches a
  // browser-verified safe terminal state.
  const [storedRun, setStoredRun] = useState<StoredProcurementRun | null>(null);
  const updateStoredRun = useCallback((run: StoredProcurementRun | null) => {
    writeStoredRun(run);
    setStoredRun(run);
  }, []);
  useEffect(() => { setStoredRun(readStoredRun()); }, []);

  useEffect(() => () => {
    runAbort.current?.abort();
    receiptAbort.current?.abort();
  }, []);

  const selected = useMemo(() => agents.find((agent) => agent.name === plan?.butler.selectedAgent), [agents, plan]);
  const execution = record(record(result).execution);
  const specialistDurationMs = typeof execution.durationMs === "number" ? execution.durationMs : undefined;
  const receiptElapsedMs = receipt?.createdAt
    ? Math.max(0, (receipt.status === "confirmed" || receipt.status === "failed" ? Date.parse(receipt.updatedAt ?? receipt.createdAt) : Date.now()) - Date.parse(receipt.createdAt))
    : 0;
  const procurementAccepted = selected?.name === "procurement-butler" && result !== undefined
    ? procurementEvidence(result).overallAccepted
    : false;
  const validateInput = useCallback((agentName: string, value: Record<string, unknown>): FieldErrors => {
    if (hasBuiltinForm(agentName)) return validateAgentInput(agentName, value);
    const schema = selected ? parseAgentFieldSchema(selected) : null;
    return schema ? validateSchemaInput(schema, value) : {};
  }, [selected]);
  const localErrors = useMemo(
    () => plan ? validateInput(plan.butler.selectedAgent, inputValue) : {},
    [plan, inputValue, validateInput],
  );
  const inputIsValid = Object.keys(localErrors).length === 0;
  // Verification completes only on evidence: a confirmed receipt (or no
  // receipt advertised at all). A synchronous broadcast-only attestation has
  // no status URL to poll, so its confirmation is UNKNOWN in this browser —
  // the Verify phase stays visibly pending rather than claiming completion.
  const verificationComplete = phase === "done" && (selected?.name === "procurement-butler"
    ? procurementAccepted
    : receipt === null || receipt.status === "confirmed");
  const resultPayload = selected?.name === "procurement-butler" ? result : record(result).result;
  const resultFields = Object.keys(record(resultPayload));
  const isProcurementSel = plan?.butler.selectedAgent === "procurement-butler";
  const procEvents = procurementJob?.events ?? [];
  // Fail-closed staging: a terminal "failed" (or unknown-phase) event attaches
  // to the stage the run had actually reached and never advances progress.
  const { byStage: eventsByStage, progress: procStage } = stageEvents(procEvents);

  // Live procurement run: each DACS stage reports the gateway's own events
  // (and their chain records) as they arrive.
  function procurementStageOutput(stageIdx: number): StageOutput {
    const events = eventsByStage[stageIdx]!;
    const latest = events[events.length - 1];
    const chain = events.filter((event) => event.txRef || event.anchorRef);
    const jobComplete = procurementJob?.status === "complete";
    const jobFailed = procurementJob?.status === "failed" || phase === "error";
    if (stageIdx === 4 && jobComplete) {
      return {
        state: procurementAccepted ? "complete" : "warning",
        summary: procurementAccepted ? "Full evidence bundle accepted & reconciled" : "Verification incomplete",
        detail: latest?.label,
        chain,
      };
    }
    if (procStage > stageIdx || jobComplete) {
      return { state: "complete", summary: latest?.label ?? "Completed", detail: events.length > 1 ? `${events.length} steps recorded` : undefined, chain };
    }
    if (procStage === stageIdx) {
      return jobFailed
        ? { state: "warning", summary: latest?.label ?? "Stopped safely", detail: error || undefined, chain }
        : { state: "active", summary: latest?.label ?? "In progress", detail: `${elapsedLabel(elapsedMs)} elapsed`, chain };
    }
    return { state: "pending", summary: "Waiting for the earlier stages" };
  }

  const identifyOut: StageOutput = !agents.length
    ? { state: "active", summary: "Reading the live agent roster…" }
    : !plan
      ? { state: "active", summary: `${agents.length} live agents on the gateway roster — pick one`, detail: agents.map((agent) => agent.label).join(", ") }
      : { state: "complete", summary: `${plan.butler.label} picked from the gateway's ${agents.length}-agent roster`, detail: "This picker is the gateway's published roster. A signed DACS-1 listing is only resolved and verified on-chain during the full Procurement run." };
  const vetOut: StageOutput = !plan
    ? { state: "pending", summary: "Waiting for an agent choice" }
    : isProcurementSel
      ? { state: "pending", summary: "Runs live during the purchase — the vet record is anchored on-chain" }
      : { state: "skipped", summary: "Skipped in this demo", detail: "The Butler already trusts this in-network specialist. Run the Procurement Butler to watch a real counterparty vet get anchored as a DACS-2 record." };
  const negotiateOut: StageOutput = !plan
    ? { state: "pending", summary: "Waiting for an agent choice" }
    : isProcurementSel
      ? { state: "pending", summary: "Runs live during the purchase — both agents sign the agreement" }
      : { state: "skipped", summary: "Skipped — this demo is free", detail: "There is nothing to price here. The Procurement Butler negotiates a real RFQ and both agents sign the DACS-3 agreement before payment." };
  const settleOut: StageOutput = phase === "running"
    ? { state: "active", summary: `Specialist working · ${elapsedLabel(elapsedMs)}`, detail: "No payment moves in this free demo — the specialist delivers its result directly. Bounded by a 2-minute deadline." }
    : phase === "done"
      ? { state: "complete", summary: specialistDurationMs === undefined ? "Result delivered" : `Result delivered in ${elapsedLabel(specialistDurationMs)}`, detail: resultFields.length ? `Result fields: ${resultFields.join(", ")}` : "The complete result is shown below." }
      : phase === "error"
        ? { state: "warning", summary: "Execution stopped safely", detail: error }
        : plan && inputIsValid
          ? { state: "pending", summary: isProcurementSel ? "A real DEM payment happens here when you press Run" : "Starts when you press Run — delivery is free in this demo" }
          : plan
            ? { state: "active", summary: "Waiting for required fields", detail: `${Object.keys(localErrors).length} field${Object.keys(localErrors).length === 1 ? " needs" : "s need"} attention in the form` }
            : { state: "pending", summary: "Waiting for job details" };
  const verifyOut: StageOutput = receipt
    ? {
        state: receipt.status === "confirmed" ? "complete" : receipt.status === "failed" ? "warning" : "active",
        summary: `Output anchor ${receipt.status}${!receipt.statusUrl && receipt.status !== "confirmed" && receipt.status !== "failed" ? " · confirmation unknown (anchoring continues on the gateway)" : ""}`,
        detail: `${receipt.txRef ? `Transaction ${compact(receipt.txRef, 14, 7)} — inspect it in Chain activity below.` : `Anchor ${compact(receipt.anchorAddress, 18, 8)}.`} This is a single-sided output anchor, not the reconciled two-party DACS-5 bundle — run the Procurement Butler for that.`,
      }
    : phase === "done"
      ? { state: "complete", summary: "Agent evidence returned", detail: "This gateway did not advertise a separate live receipt for this agent. The reconciled DACS-5 bundle is only produced by the full Procurement run." }
      : { state: "pending", summary: "Waiting for delivery" };

  // A live/finished procurement job reports the real gateway events per stage;
  // everything else (specialists, and procurement before the run) uses the
  // honest static mapping — including visibly-skipped stages.
  const stageOutputs: StageOutput[] = isProcurementSel && procEvents.length
    ? DACS_STAGES.map((_, stageIdx) => procurementStageOutput(stageIdx))
    : [identifyOut, vetOut, negotiateOut, settleOut, verifyOut];

  // Every chain record seen this run (procurement events + the specialist
  // receipt), so all transactions stay visible in one place with explorer links.
  const chainActivity: Array<{ label: string; txRef?: string; anchorRef?: string }> = [
    ...procEvents.filter((event) => event.txRef || event.anchorRef).map((event) => ({ label: event.label, txRef: event.txRef, anchorRef: event.anchorRef })),
    ...(receipt ? [{ label: "Output attestation anchored", txRef: receipt.txRef, anchorRef: receipt.anchorAddress }] : []),
  ];
  const chainTxCount = chainActivity.filter((row) => row.txRef).length;

  async function watchReceipt(initial: OutputReceipt) {
    // The synchronous LIVE-ANCHOR attestation has no status URL: there is
    // nothing to poll — the anchor status shown is already the final report
    // from the run response.
    const statusUrl = initial.statusUrl;
    if (!statusUrl) return;
    receiptAbort.current?.abort();
    const controller = new AbortController();
    receiptAbort.current = controller;
    setReceiptPolling(true); setReceiptMessage("");
    let current = initial;
    const deadline = Date.now() + RECEIPT_WATCH_TIMEOUT_MS;
    try {
      while (current.status !== "confirmed" && current.status !== "failed") {
        if (Date.now() >= deadline) {
          setReceiptMessage("Receipt confirmation is taking longer than two minutes. The result is safe; you can check again without rerunning the agent.");
          return;
        }
        await waitWithSignal(Math.min(1_500, deadline - Date.now()), controller.signal);
        const { response, body } = await fetchJsonBeforeDeadline(
          new URL(current.statusUrl ?? statusUrl, `${BUTLER}/`),
          { signal: controller.signal },
          deadline,
          fetch,
          "Receipt status checking exceeded two minutes.",
        );
        if (!response.ok) throw new Error(message(body));
        current = parseReceiptEnvelope(body);
        setReceipt(current);
      }
      if (current.status === "failed") setReceiptMessage(current.error ?? "Receipt anchoring failed safely. Retry will reuse the same receipt and wallet queue.");
    } catch (cause) {
      if ((cause as Error).name !== "AbortError") setReceiptMessage((cause as Error).message);
    } finally {
      if (receiptAbort.current === controller) {
        receiptAbort.current = null;
        setReceiptPolling(false);
      }
    }
  }

  async function retryReceipt() {
    if (!receipt?.statusUrl) return;
    try {
      let next = receipt;
      if (receipt.status === "failed") {
        const { response, body } = await fetchJsonWithTimeout(
          new URL(`${receipt.statusUrl}/retry`, `${BUTLER}/`),
          { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
          15_000,
          "The receipt retry request timed out.",
        );
        if (!response.ok) throw new Error(message(body));
        next = parseReceiptEnvelope(body);
        setReceipt(next);
      }
      void watchReceipt(next);
    } catch (cause) {
      setReceiptMessage((cause as Error).message);
    }
  }

  function cancelRun() {
    runAbort.current?.abort();
  }

  function cancelReceiptWatch() {
    receiptAbort.current?.abort();
    setReceiptPolling(false);
    setReceiptMessage("Stopped checking in this browser. The gateway will continue nonce-safe anchoring in the background.");
  }

  async function runAgent() {
    if (!plan) return;
    let parsed: Record<string, unknown>;
    try { parsed = parseAgentInput(inputValue); }
    catch (cause) {
      setError((cause as Error).message);
      return;
    }
    // Local validation is advisory feedback; a hard local failure blocks the
    // obviously-broken submissions, the gateway remains authoritative.
    const advisory = validateInput(plan.butler.selectedAgent, parsed);
    if (Object.keys(advisory).length > 0) {
      setError("Some fields need attention before this can run — see the highlighted inputs.");
      return;
    }
    // A new procurement run must not overwrite the persisted record of an
    // earlier, unreconciled one — that record may be the only handle on a
    // paid job. Retrying the SAME run (matching key) passes through.
    if (plan.butler.selectedAgent === "procurement-butler" && storedRun && storedRun.runId !== procurementRunId.current) {
      setError("An earlier procurement run from this browser is still on record. Use “Check & resume” in the banner above (or dismiss it once reconciled) before starting a new purchase.");
      return;
    }
    runAbort.current?.abort(); receiptAbort.current?.abort();
    const controller = new AbortController();
    runAbort.current = controller;
    setPhase("running"); setError(""); setResult(undefined); setReceipt(null); setReceiptMessage("");
    // Clear any prior job before a fresh start so a failed start can never
    // offer resuming a stale job (ref set synchronously: the catch below may
    // run before the state-sync effect).
    setProcurementJob(null); procurementJobRef.current = null;
    setGatewayFieldErrors({});
    setSubmittedSummary(summarizeAgentInput(plan.butler.selectedAgent, parsed));
    setRunStartedAt(Date.now()); setElapsedMs(0);
    // A 4xx whose details name specific fields returns the user to the form
    // with the gateway's own words beside the inputs (authoritative).
    const fieldMappedRejection = (body: unknown): boolean => {
      const envelope = record(record(body).error);
      const gatewayMessage = typeof envelope.message === "string" ? envelope.message : "";
      const details = Array.isArray(envelope.details) ? envelope.details.filter((line): line is string => typeof line === "string") : undefined;
      if (!gatewayMessage) return false;
      const mapped = mapGatewayErrors(gatewayMessage, details, flattenInputKeys(parsed));
      if (Object.keys(mapped.byField).length === 0) return false;
      setGatewayFieldErrors(mapped.byField);
      setError([gatewayMessage, ...mapped.global].filter(Boolean).join(" — "));
      setPhase("ready");
      return true;
    };
    try {
      if (plan.butler.selectedAgent === "procurement-butler") {
        const deadline = Date.now() + 12 * 60_000;
        // The Directory is the discovery surface. Pass its verified listing
        // pointer to the Butler; the gateway independently dereferences and
        // verifies the signed DACS-1 artifact before negotiation.
        const request = { ...parsed };
        try {
          const { response: catalog, body } = await fetchJsonBeforeDeadline<{ listings?: Array<{ listingId?: string; anchor?: { locator?: string }; offering?: { title?: string; negotiation?: string[] } }> }>("/api/dacs/listings?rail=pay-dem&limit=100", { signal: controller.signal }, deadline);
          if (catalog.ok) {
            const auditor = body.listings?.find((item) => item.listingId === "audit-negotiator" && item.offering?.negotiation?.includes("rfq") && /auditor/i.test(item.offering?.title ?? ""));
            const ref = auditor?.anchor?.locator;
            if (ref) request.auditorListingRef = ref;
          }
        } catch { /* gateway will derive and verify the configured Auditor slot */ }
        // One key per intentional run; a retry of this same run reuses it so
        // the gateway dedupes to the existing job (never a second payment).
        procurementRunId.current ??= crypto.randomUUID();
        // Persist the key + input BEFORE dispatch: a reload/crash between the
        // POST and the job-id response must not lose the only handle on a
        // purchase the gateway may have started. Restored on mount.
        const runRecord: StoredProcurementRun = { runId: procurementRunId.current, goal, input: request, startedAt: new Date().toISOString() };
        updateStoredRun(runRecord);
        const { response: start, body: startBody } = await fetchJsonBeforeDeadline(`${BUTLER}/demo/procurement`, {
          method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": procurementRunId.current },
          body: JSON.stringify(request), signal: controller.signal,
        }, deadline);
        if (!start.ok) {
          // A 4xx is a verified pre-job rejection (nothing was created), so
          // the persisted record has nothing to protect. A 5xx/opaque failure
          // keeps it: the job may exist, and the key is the only handle.
          if (start.status >= 400 && start.status < 500) updateStoredRun(null);
          if (fieldMappedRejection(startBody)) return;
          throw new Error(message(startBody));
        }
        const started = parseProcurementJob(startBody);
        procurementJobRef.current = started;   // synchronous — the catch relies on it
        updateStoredRun({ ...runRecord, jobId: started.id });
        setProcurementJob(started);
        await followProcurementJob(started, controller, deadline);
        return;
      }
      const { response: res, body } = await fetchJsonWithTimeout(`${BUTLER}/demo/butler`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal, agent: plan.butler.selectedAgent, input: parsed }),
        signal: controller.signal,
      }, AGENT_TIMEOUT_MS, AGENT_TIMEOUT_MESSAGE);
      if (!res.ok) {
        if (fieldMappedRejection(body)) return;
        throw new Error(message(body));
      }
      const completed = parseButlerRun(body);
      setResult(completed); setPhase("done");
      if (completed.outputAttestation) {
        setReceipt(completed.outputAttestation);
        void watchReceipt(completed.outputAttestation);
      }
    } catch (cause) {
      const cancelled = (cause as Error).name === "AbortError";
      const isProcurement = plan.butler.selectedAgent === "procurement-butler";
      const haveJob = procurementJobRef.current !== null;
      // The retry-reuses-the-key reassurance only holds while the key is
      // retained — a terminal failed job is explained by the recovery box
      // instead, so its gateway reason is shown verbatim.
      const failedJob = procurementJobRef.current?.status === "failed";
      setError(cancelled
        ? isProcurement && haveJob
          ? "Stopped watching in this browser. The gateway is still completing this procurement job — it was NOT cancelled, and any payment it makes still happens. Resume below to keep following the same job; no second purchase will be started."
          : "Run cancelled in this browser. No result was accepted; you can retry the same bounded job."
        : isProcurement && !failedJob
          ? `${(cause as Error).message} — Retrying reuses the same idempotency key, so the gateway resumes the existing job instead of starting a second paid purchase.`
          : (cause as Error).message);
      setPhase("error");
    } finally {
      if (runAbort.current === controller) runAbort.current = null;
    }
  }

  /**
   * Follow an already-started procurement job to completion. Used by the
   * initial run and by "Resume status" after the user stops watching — the
   * job id is retained so resuming NEVER creates a second job or payment.
   */
  async function followProcurementJob(initial: ProcurementJob, controller: AbortController, deadline: number) {
    let current = initial;
    while (current.status === "running" && Date.now() < deadline) {
      await waitWithSignal(Math.min(2_000, Math.max(0, deadline - Date.now())), controller.signal);
      const { response: poll, body: pollBody } = await fetchJsonBeforeDeadline(`${BUTLER}/demo/procurement/${encodeURIComponent(current.id)}`, { signal: controller.signal }, deadline);
      if (!poll.ok) throw new Error(message(pollBody));
      current = parseProcurementJob(pollBody); setProcurementJob(current);
    }
    if (current.status === "failed") {
      // Only the gateway's explicit failedBeforePayment=true proves no money
      // moved — then (and only then) a fresh purchase is safe, so the key and
      // persisted record are released. Anything else (flag false or absent)
      // may have paid: keep both, so the job stays referenced for the
      // gateway's operator recovery path and no new purchase is offered.
      if (current.failedBeforePayment === true) {
        procurementRunId.current = null;
        updateStoredRun(null);
      }
      throw new Error(current.error ?? "the full procurement flow failed safely");
    }
    if (current.status !== "complete") throw new Error("the full procurement flow is still running; use Resume status to keep following it");
    setResult(current.result); setPhase("done");
    procurementRunId.current = null;
    updateStoredRun(null);
  }

  /** Resume following the existing procurement job (never a new purchase). */
  async function resumeProcurement() {
    const job = procurementJobRef.current;
    if (!job) return;
    runAbort.current?.abort();
    const controller = new AbortController();
    runAbort.current = controller;
    setPhase("running"); setError("");
    setRunStartedAt(Date.now()); setElapsedMs(0);
    try {
      await followProcurementJob(job, controller, Date.now() + 12 * 60_000);
    } catch (cause) {
      const cancelled = (cause as Error).name === "AbortError";
      setError(cancelled
        ? "Stopped watching in this browser. The gateway is still completing this procurement job — resume below to keep following it; no second purchase will be started."
        : (cause as Error).message);
      setPhase("error");
    } finally {
      if (runAbort.current === controller) runAbort.current = null;
    }
  }

  /**
   * Reconcile a persisted run after a reload. With a job id this only reads
   * status. Without one (the reload raced the POST response) it re-POSTs the
   * SAME stored input under the SAME idempotency key, so the gateway returns
   * the original job if it exists — it can never start a second purchase for
   * this run.
   */
  async function resumeStoredRun() {
    const stored = storedRun;
    if (!stored) return;
    runAbort.current?.abort(); receiptAbort.current?.abort();
    const controller = new AbortController();
    runAbort.current = controller;
    procurementRunId.current = stored.runId;
    setGoal(stored.goal);
    setPlan({
      butler: {
        selectedAgent: "procurement-butler",
        label: "Procurement Butler",
        selectionEngine: "restored run",
        rationale: "Reconnecting to the procurement run this browser dispatched earlier — same idempotency key, so no second purchase can start.",
        alternatives: [],
      },
      proposedInput: stored.input,
      inputNote: "Restored from this browser's persisted run record.",
    });
    setInputValue(stored.input);
    setResult(undefined); setReceipt(null); setReceiptMessage(""); setGatewayFieldErrors({});
    setProcurementJob(null); procurementJobRef.current = null;
    setSubmittedSummary(summarizeAgentInput("procurement-butler", stored.input));
    setPhase("running"); setError("");
    setRunStartedAt(Date.now()); setElapsedMs(0);
    const deadline = Date.now() + 12 * 60_000;
    try {
      let job: ProcurementJob;
      if (stored.jobId) {
        const { response, body } = await fetchJsonBeforeDeadline(`${BUTLER}/demo/procurement/${encodeURIComponent(stored.jobId)}`, { signal: controller.signal }, deadline);
        if (!response.ok) throw new Error(message(body));
        job = parseProcurementJob(body);
      } else {
        const { response, body } = await fetchJsonBeforeDeadline(`${BUTLER}/demo/procurement`, {
          method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": stored.runId },
          body: JSON.stringify(stored.input), signal: controller.signal,
        }, deadline);
        if (!response.ok) {
          if (response.status >= 400 && response.status < 500) updateStoredRun(null);
          throw new Error(message(body));
        }
        job = parseProcurementJob(body);
        updateStoredRun({ ...stored, jobId: job.id });
      }
      procurementJobRef.current = job;
      setProcurementJob(job);
      await followProcurementJob(job, controller, deadline);
    } catch (cause) {
      const cancelled = (cause as Error).name === "AbortError";
      const failedJob = procurementJobRef.current?.status === "failed";
      setError(cancelled
        ? "Stopped watching in this browser. Any live gateway job continues — resume again to keep following it."
        : failedJob
          ? (cause as Error).message
          : `${(cause as Error).message} — Resuming again reuses the same idempotency key, so no second purchase can start.`);
      setPhase("error");
    } finally {
      if (runAbort.current === controller) runAbort.current = null;
    }
  }

  function selectAgent(agent: AgentCard) {
    runAbort.current?.abort(); receiptAbort.current?.abort();
    setGoal(agent.exampleGoal);
    setPlan({
      butler: {
        selectedAgent: agent.name,
        label: agent.label,
        selectionEngine: "user-selected test",
        rationale: `You selected ${agent.label}. Fill in the job below (or load its example), and I will supervise the run and show you the evidence it returns.`,
        alternatives: [],
      },
      proposedInput: agent.exampleInput,
      inputNote: "Your values are submitted unchanged to the live gateway, which applies specialist validation before execution.",
    });
    // Switching agents resets to that agent's blank form. Examples are never
    // submitted silently — "Load example" below is the only way they enter.
    // Schema-driven agents seed select/checkbox defaults so the form's display
    // matches submitted state.
    const schema = hasBuiltinForm(agent.name) ? null : parseAgentFieldSchema(agent);
    setInputValue(schema ? initialSchemaInput(schema) : initialAgentInput(agent.name));
    procurementRunId.current = null;
    setGatewayFieldErrors({}); setSubmittedSummary([]);
    setResult(undefined); setProcurementJob(null); setReceipt(null); setReceiptMessage(""); setPhase("ready"); setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function loadExample() {
    if (!selected) return;
    procurementRunId.current = null;
    setInputValue(JSON.parse(JSON.stringify(selected.exampleInput)) as Record<string, unknown>);
    setGatewayFieldErrors({});
    setError("");
  }

  function editInput(next: Record<string, unknown>) {
    setInputValue(next);
    // Edited input is a new intent: a fresh idempotency key so a retry can't
    // dedupe to a job that ran the previous payload.
    procurementRunId.current = null;
    // Stale gateway verdicts don't apply to edited input.
    if (Object.keys(gatewayFieldErrors).length) setGatewayFieldErrors({});
  }

  return (
    <div className="try-page">
      <section className="try-hero">
        <div>
          <span className="try-kicker"><i /> LIVE DACS WALKTHROUGH</span>
          <h1>Pick an agent.<br /><em>Watch it work.</em></h1>
        </div>
        <p>Choose one of the live test agents. The Butler will explain its role, validate the test, supervise the work and show you how DACS verifies the result.</p>
      </section>

      {storedRun && phase !== "running" && procurementJob?.id !== storedRun.jobId && (
        <section className="resume-banner" role="alert">
          <div>
            <strong>A procurement run from this browser is still on record</strong>
            <p>Started {new Date(storedRun.startedAt).toLocaleString()}{storedRun.jobId ? ` · job ${compact(storedRun.jobId, 8, 6)}` : " · the job id was never received"}. Resuming reconnects under the same idempotency key, so it can never start a second purchase.</p>
          </div>
          <div className="resume-actions">
            <button className="ghost-btn" onClick={() => { if (window.confirm("Dismiss this reminder? If the run paid, its job remains preserved on the gateway — only dismiss once you no longer need this browser to track it.")) updateStoredRun(null); }}>Dismiss</button>
            <button className="btn" onClick={resumeStoredRun}>Check &amp; resume <span>→</span></button>
          </div>
        </section>
      )}

      <section className="try-shell">
        <div className="butler-chat">
          <div className="chat-head"><span className="butler-avatar">B</span><div><strong>DACS Butler</strong><small>{agents.length ? `${agents.length} specialists online · agent gateway connected` : "Connecting to the agent network…"}</small></div></div>
          <div className="chat-body" aria-live="polite">
            <div className="bubble butler"><span>Butler</span><p>Welcome. Pick one of our test agents below and I’ll walk you through exactly what it does and what DACS verifies.</p></div>
            {goal && phase !== "idle" && <div className="bubble human"><span>You</span><p>{goal}</p></div>}
            {plan && <div className="bubble butler"><span>Butler</span><p><strong>{plan.butler.label}</strong> is ready. {plan.butler.rationale}</p><div className="reasoning-chip">{plan.butler.selectionEngine}</div></div>}
            {phase === "done" && <div className="bubble butler"><span>Butler</span><p>The specialist finished. Its result is ready now; the separate receipt status below shows any on-chain anchoring still completing in the background.</p></div>}
            {error && <div className="bubble error"><span>Stopped safely</span><p>{error}</p></div>}
          </div>

          {phase === "idle" || (phase === "error" && !plan) ? (
            <div className="agent-picker">
              <div className="picker-head"><strong>Choose a test agent</strong><span>{agents.length} available</span></div>
              <div className="picker-grid">{agents.map((agent) => <button key={agent.name} onClick={() => selectAgent(agent)}><span>{agent.label.slice(0, 1)}</span><div><strong>{agent.label}</strong><small>{agent.summary}</small></div><i>→</i></button>)}</div>
            </div>
          ) : phase === "error" && plan ? (
            <div className="job-box recovery-box">
              {plan.butler.selectedAgent === "procurement-butler" && procurementJob?.status === "failed" && procurementJob.failedBeforePayment === true ? (
                <>
                  <div><strong>Procurement failed before any payment</strong><small>The gateway confirms no money moved (its reason is shown above). Retrying starts a fresh purchase attempt with a new idempotency key.</small></div>
                  <div className="job-actions"><button className="ghost-btn" onClick={() => { setPhase("idle"); setPlan(null); setError(""); setProcurementJob(null); }}>Choose another agent</button><button className="ghost-btn" onClick={() => { setPhase("ready"); setProcurementJob(null); setError(""); }}>Edit details</button><button className="btn try-primary" onClick={runAgent}>Retry the purchase <span>→</span></button></div>
                </>
              ) : plan.butler.selectedAgent === "procurement-butler" && procurementJob?.status === "failed" ? (
                <>
                  <div><strong>Procurement failed after payment may have moved — do not re-purchase</strong><small>Job {procurementJob.id} is preserved on the gateway with its payment evidence; the gateway cannot confirm the failure happened before payment, so starting a new run could pay twice. A gateway operator can recover the delivery for the existing job without another payment.</small></div>
                  <div className="job-actions"><button className="ghost-btn" onClick={() => { setPhase("idle"); setPlan(null); setError(""); setProcurementJob(null); }}>Choose another agent</button></div>
                </>
              ) : plan.butler.selectedAgent === "procurement-butler" && procurementJob ? (
                <>
                  <div><strong>Watching stopped — the procurement job is still live on the gateway</strong><small>Job {procurementJob.id} was not cancelled; resuming follows the same job and never starts a second purchase.</small></div>
                  <div className="job-actions"><button className="ghost-btn" onClick={() => { setPhase("idle"); setPlan(null); setError(""); setProcurementJob(null); }}>Choose another agent</button><button className="btn try-primary" onClick={resumeProcurement}>Resume status <span>→</span></button></div>
                </>
              ) : plan.butler.selectedAgent === "procurement-butler" ? (
                <>
                  <div><strong>Procurement stopped safely</strong><small>Retrying reuses this run’s idempotency key, so the gateway resumes the existing job rather than starting a second paid purchase.</small></div>
                  <div className="job-actions"><button className="ghost-btn" onClick={() => { setPhase("idle"); setPlan(null); setError(""); setProcurementJob(null); }}>Choose another agent</button><button className="btn try-primary" onClick={runAgent}>Retry this run <span>→</span></button></div>
                </>
              ) : (
                <>
                  <div><strong>{plan.butler.label} stopped safely</strong><small>Your entered job details are still available.</small></div>
                  <div className="job-actions"><button className="ghost-btn" onClick={() => { setPhase("idle"); setPlan(null); setError(""); }}>Choose another agent</button><button className="ghost-btn" onClick={() => setPhase("ready")}>Edit details</button><button className="btn try-primary" onClick={runAgent}>Retry this agent <span>→</span></button></div>
                </>
              )}
            </div>
          ) : plan && phase === "ready" && selected ? (
            <div className="job-box">
              <div className="job-head"><div><span>Job details</span><small>{plan.inputNote}</small></div><span className={`badge ${inputIsValid ? "ok" : "err"}`}>{inputIsValid ? "ready to run" : "fields need attention"}</span></div>
              <AgentInputForm agent={selected} value={inputValue} onChange={editInput} errors={localErrors} gatewayErrors={gatewayFieldErrors} />
              <div className="job-actions">
                <button className="ghost-btn" onClick={() => setPhase("idle")}>Start over</button>
                <button className="ghost-btn" onClick={loadExample}>Load example</button>
                <button className="btn try-primary" onClick={runAgent} disabled={!inputIsValid}>Run this agent <span>→</span></button>
              </div>
            </div>
          ) : phase === "running" && plan?.butler.selectedAgent === "procurement-butler" ? (
            <div className="live-flow"><div className="live-flow-head"><div><span className="live-pulse" /> FULL DACS FLOW RUNNING · {elapsedLabel(elapsedMs)}</div><small>Keep this page open — chain confirmations appear here live.</small></div>{submittedSummary.length > 0 && <div className="submitted-summary"><span>SUBMITTED</span><ul>{submittedSummary.map((line, index) => <li key={index}>{line}</li>)}</ul></div>}<div className="live-events">{(procurementJob?.events ?? []).map((event, index) => <div key={`${event.at}-${index}`} className={index === (procurementJob?.events.length ?? 0) - 1 ? "active" : "done"}><i>{index === (procurementJob?.events.length ?? 0) - 1 ? "·" : "✓"}</i><span><strong>{event.label}</strong><small>{new Date(event.at).toLocaleTimeString()}{event.txRef ? ` · tx ${compact(event.txRef, 12, 6)}` : ""}</small></span></div>)}</div><div className="live-flow-actions"><button className="ghost-btn" onClick={cancelRun}>Stop watching (the job continues)</button></div></div>
          ) : phase === "running" ? <div className="job-box working-box"><div><span className="live-pulse" /><strong>Specialist is working</strong><small>Agent execution · {elapsedLabel(elapsedMs)} elapsed · 2-minute deadline</small>{submittedSummary.length > 0 && <div className="submitted-summary"><span>SUBMITTED</span><ul>{submittedSummary.map((line, index) => <li key={index}>{line}</li>)}</ul></div>}</div><button className="ghost-btn" onClick={cancelRun}>Cancel</button></div>
          : null}
        </div>

        <aside className="journey" aria-label="The five DACS stages">
          <div className="journey-head"><span>THE DACS DEAL</span><span>{verificationComplete ? "COMPLETE" : "LIVE"}</span></div>
          <p className="journey-intro">One deal leaves five signed receipts: <em>Identify → Vet → Negotiate → Settle → Verify</em>. Each stage below reports the real evidence it produced — nothing is ticked off without proof.</p>
          <div className="journey-steps">
            {DACS_STAGES.map((stage, index) => {
              const output = stageOutputs[index]!;
              return (
                <div className={`journey-step ${output.state}`} key={stage.key}>
                  <span className="journey-index">{output.state === "complete" ? "✓" : index + 1}</span>
                  <div>
                    <div className="stage-title"><strong>{stage.name}</strong><span className="dacs-tag">{stage.primitive}</span></div>
                    <p>{stage.tagline}</p>
                    <div className={`phase-output ${output.state}`}>
                      <span>{output.state === "skipped" ? "not in this demo" : output.state}</span>
                      <b>{output.summary}</b>
                      {output.detail && <small>{output.detail}</small>}
                      {output.chain && output.chain.length > 0 && (
                        <div className="stage-txs">{output.chain.map((event, chainIdx) => event.txRef
                          ? <a key={chainIdx} href={`${EXPLORER}/tx/${event.txRef}`} target="_blank" rel="noreferrer" title={event.label}>tx {compact(event.txRef, 8, 6)} ↗</a>
                          : <code key={chainIdx} title={event.label}>{compact(event.anchorRef, 12, 6)}</code>)}</div>
                      )}
                    </div>
                    <details className="stage-help">
                      <summary>What’s happening here?</summary>
                      <p>{stage.plain} <b>{output.state === "skipped" ? `Proof this stage normally creates: ${stage.receipt} — not produced in this demo.` : `Proof this stage creates: ${stage.receipt}.`}</b></p>
                    </details>
                  </div>
                </div>
              );
            })}
          </div>
          {chainActivity.length > 0 && (
            <div className="chain-activity">
              <div className="chain-activity-head"><span>CHAIN ACTIVITY</span><span>{chainTxCount} tx · {chainActivity.length - chainTxCount} anchors</span></div>
              <p>Every receipt lands on the public Demos chain. Click a hash to inspect it yourself — no login, no trust required.</p>
              <div className="chain-activity-list">
                {chainActivity.map((row, index) => (
                  <div className="chain-row" key={`${row.txRef ?? row.anchorRef}-${index}`}>
                    <span className="chain-index">{String(index + 1).padStart(2, "0")}</span>
                    <div><strong>{row.label}</strong>{row.anchorRef && <small>anchor {compact(row.anchorRef, 16, 6)}</small>}</div>
                    {row.txRef ? <a href={`${EXPLORER}/tx/${row.txRef}`} target="_blank" rel="noreferrer">{compact(row.txRef, 8, 6)} ↗</a> : <span className="muted-text">anchor</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="journey-note"><strong>Evidence, not theatre</strong><p>Each box reports data already returned by that stage. Pending work stays visibly pending, skipped stages say so, and full artifacts remain inspectable below.</p></div>
        </aside>
      </section>

      {result !== undefined && <section className={`try-result ${selected?.name === "procurement-butler" ? "full-proc-result" : ""}`}><div className="result-title"><div><span className={`badge ${selected?.name === "procurement-butler" && !procurementAccepted ? "err" : "ok"}`}>{selected?.name === "procurement-butler" ? (procurementAccepted ? "verified" : "verification incomplete") : "completed"}</span><h2>{selected?.label ?? "Agent"} result</h2>{specialistDurationMs !== undefined && <small>Specialist completed in {elapsedLabel(specialistDurationMs)}</small>}</div><button className="ghost-btn" onClick={() => { runAbort.current?.abort(); receiptAbort.current?.abort(); setPhase("idle"); setPlan(null); setResult(undefined); setProcurementJob(null); setReceipt(null); setReceiptMessage(""); }}>Try another goal</button></div>{receipt && <div className={`receipt-status receipt-${receipt.status}`}><div><span className={receiptPolling ? "live-pulse" : "receipt-dot"} /><strong>On-chain receipt: {receipt.status}</strong><small>{receipt.note}{receipt.createdAt ? ` · ${elapsedLabel(receiptElapsedMs)}` : ""}{receipt.attempts !== undefined ? ` · attempt ${receipt.attempts}/3` : ""}</small>{receiptMessage && <p>{receiptMessage}</p>}</div><div className="receipt-actions">{receipt.txRef && <a className="ghost-btn" href={`${EXPLORER}/tx/${receipt.txRef}`} target="_blank" rel="noreferrer">View transaction ↗</a>}{receiptPolling ? <button className="ghost-btn" onClick={cancelReceiptWatch}>Stop checking</button> : receipt.statusUrl && receipt.status !== "confirmed" ? <button className="ghost-btn" onClick={retryReceipt}>{receipt.status === "failed" ? "Retry anchoring" : "Check again"}</button> : null}</div></div>}{selected?.name === "procurement-butler" ? <ProcurementReport value={result} events={procurementJob?.events ?? []} /> : <details open><summary>Human-readable execution result</summary><pre>{JSON.stringify(result, null, 2)}</pre></details>}</section>}

      <section className="try-agents"><div className="try-section-head"><div><span>WHAT YOU CAN TEST</span><h2>Nine bounded agent demonstrations</h2></div><p>Each test uses a safe, validated fixture. The Butler supervises execution; it does not invent arbitrary jobs or access private data.</p></div><div className="try-agent-grid">{agents.slice(0, 6).map((agent, index) => <button key={agent.name} onClick={() => selectAgent(agent)}><span>0{index + 1}</span><strong>{agent.label}</strong><p>{agent.exampleGoal}</p><i>Select this agent →</i></button>)}</div></section>
    </div>
  );
}
