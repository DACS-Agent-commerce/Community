export type AgentCard = {
  name: string;
  label: string;
  summary: string;
  tags: string[];
  exampleGoal: string;
  exampleInput: Record<string, unknown>;
  /** Optional gateway-published execution mode (passed through verbatim). */
  mode?: string;
  /** Optional gateway-published input field schema (name/type/required/description). */
  input?: unknown;
};

export type ProcurementProfile = {
  id: string;
  title: string;
  agentName: string;
  serviceId: string;
  mode: string;
  negotiationPhase: string;
  summary: string;
  fields: unknown[];
  sampleInput: Record<string, unknown>;
  timing: {
    healthyMinSec: number;
    healthyMaxSec: number;
    hardTimeoutSec: number;
    protocolFloorSec: number;
  };
  confirmationGates: string[];
  implementationStatus: string;
  executable: boolean;
  reasons: string[];
};

const PROFILE_AGENT_NAMES: Record<string, string> = {
  "oracle-auto-accept": "oracle-desk",
  "dd-live-fixed": "dd-researcher",
  "security-audit-rfq": "procurement-butler",
};

/** Only these production profiles are deliberately presented as live demos. */
export const LIVE_PROCUREMENT_PROFILE_IDS = Object.freeze(Object.keys(PROFILE_AGENT_NAMES));

export type ProcurementEvent = {
  phase: string;
  label: string;
  at: string;
  txRef?: string;
  anchorRef?: string;
};

export type ProcurementJob = {
  id: string;
  status: "running" | "complete" | "failed";
  phase: string;
  events: ProcurementEvent[];
  result?: unknown;
  error?: string;
  /**
   * Gateway-published only on failed jobs: true means NO payment was
   * broadcast, so a fresh purchase is safe. Absent or false must be treated
   * as "a payment may exist" — never re-purchase.
   */
  failedBeforePayment?: boolean;
};

export type ProcurementEvidence = {
  statusAccepted: boolean;
  paymentRecorded: boolean;
  negotiationSigned: boolean;
  negotiationVerified: boolean;
  deliveryVerified: boolean;
  bundlesVerified: boolean;
  reconciled: boolean;
  rulingValid: boolean;
  rulingAccepted: boolean;
  rulingRequired: boolean;
  overallAccepted: boolean;
};

export type ReceiptStatus = "queued" | "anchoring" | "broadcast" | "confirmed" | "failed";

/**
 * The gateway publishes two attestation shapes: the asynchronous receipt
 * (receiptId + statusUrl, pollable/retryable) and the synchronous
 * LIVE-ANCHOR-storage attestation (digest + anchor + txRef, no status URL).
 * Both carry status/digest/anchorAddress/note; polling fields are optional
 * and the UI only polls or retries when a statusUrl is present.
 */
export type OutputReceipt = {
  receiptId?: string;
  statusUrl?: string;
  status: ReceiptStatus;
  attempts?: number;
  createdAt?: string;
  updatedAt?: string;
  digest: string;
  anchorAddress: string;
  anchorName?: string;
  scheme?: string;
  committedBy?: string;
  txRef?: string;
  error?: string;
  note: string;
};

export type ButlerRun = Record<string, unknown> & {
  result: unknown;
  execution?: { requestId: string; durationMs: number };
  outputAttestation?: OutputReceipt;
};

export class ButlerContractError extends Error {
  constructor(path: string, expectation: string) {
    super(`Butler gateway returned an invalid ${path}; expected ${expectation}`);
    this.name = "ButlerContractError";
  }
}

export class AgentInputError extends Error {
  constructor() {
    super("Job details must be a JSON object, not a string, array, or null.");
    this.name = "AgentInputError";
  }
}

export const PROCUREMENT_TIMEOUT_MESSAGE = "The full procurement flow exceeded its 12-minute deadline.";
export const AGENT_TIMEOUT_MESSAGE = "The specialist did not respond within 2 minutes. You can retry or cancel safely.";

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredRecord(value: unknown, path: string): Record<string, unknown> {
  const parsed = record(value);
  if (Object.keys(parsed).length === 0 && (value === null || typeof value !== "object" || Array.isArray(value))) {
    throw new ButlerContractError(path, "an object");
  }
  return parsed;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ButlerContractError(path, "a non-empty string");
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, path);
}

function requiredNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ButlerContractError(path, "a finite number");
  return value;
}

export function parseAgentInput(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AgentInputError();
  return value as Record<string, unknown>;
}

export async function fetchJsonBeforeDeadline<T = unknown>(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  deadlineMs: number,
  fetcher: typeof fetch = fetch,
  timeoutMessage = PROCUREMENT_TIMEOUT_MESSAGE,
): Promise<{ response: Response; body: T }> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) throw new Error(timeoutMessage);
  const controller = new AbortController();
  const externalSignal = init?.signal;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  let deadlineExpired = false;
  const timer = setTimeout(() => {
    deadlineExpired = true;
    controller.abort();
  }, remainingMs);
  try {
    const response = await fetcher(input, { ...init, signal: controller.signal });
    const body = await response.json() as T;
    return { response, body };
  } catch (cause) {
    if (deadlineExpired) throw new Error(timeoutMessage);
    throw cause;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

export function fetchJsonWithTimeout<T = unknown>(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
  timeoutMessage: string,
  fetcher: typeof fetch = fetch,
): Promise<{ response: Response; body: T }> {
  return fetchJsonBeforeDeadline(input, init, Date.now() + timeoutMs, fetcher, timeoutMessage);
}

export function parseAgentCatalog(value: unknown): AgentCard[] {
  const body = requiredRecord(value, "agent catalog");
  if (!Array.isArray(body.agents)) throw new ButlerContractError("agent catalog.agents", "an array");
  if (body.agents.length === 0) throw new ButlerContractError("agent catalog.agents", "at least one agent");
  return body.agents.map((value, index) => {
    const path = `agent catalog.agents[${index}]`;
    const agent = requiredRecord(value, path);
    if (!Array.isArray(agent.tags) || agent.tags.some((tag) => typeof tag !== "string")) {
      throw new ButlerContractError(`${path}.tags`, "an array of strings");
    }
    return {
      name: requiredString(agent.name, `${path}.name`),
      label: requiredString(agent.label, `${path}.label`),
      summary: requiredString(agent.summary, `${path}.summary`),
      tags: agent.tags,
      exampleGoal: requiredString(agent.exampleGoal, `${path}.exampleGoal`),
      exampleInput: requiredRecord(agent.exampleInput, `${path}.exampleInput`),
      // Pass the gateway's own schema surface through untouched; the form
      // layer decides whether it can render it (and falls back safely).
      mode: optionalString(agent.mode, `${path}.mode`),
      input: agent.input,
    };
  });
}

export function parseProcurementProfiles(value: unknown): ProcurementProfile[] {
  const body = requiredRecord(value, "procurement options");
  if (!Array.isArray(body.profiles)) throw new ButlerContractError("procurement options.profiles", "an array");
  return body.profiles.map((value, index) => {
    const path = `procurement options.profiles[${index}]`;
    const profile = requiredRecord(value, path);
    const timing = requiredRecord(profile.timing, `${path}.timing`);
    if (!Array.isArray(profile.fields)) throw new ButlerContractError(`${path}.fields`, "an array");
    if (!Array.isArray(profile.confirmationGates) || profile.confirmationGates.some((gate) => typeof gate !== "string")) {
      throw new ButlerContractError(`${path}.confirmationGates`, "an array of strings");
    }
    if (!Array.isArray(profile.reasons) || profile.reasons.some((reason) => typeof reason !== "string")) {
      throw new ButlerContractError(`${path}.reasons`, "an array of strings");
    }
    if (typeof profile.executable !== "boolean") throw new ButlerContractError(`${path}.executable`, "a boolean");
    return {
      id: requiredString(profile.id, `${path}.id`),
      title: requiredString(profile.title, `${path}.title`),
      agentName: requiredString(profile.agentName, `${path}.agentName`),
      serviceId: requiredString(profile.serviceId, `${path}.serviceId`),
      mode: requiredString(profile.mode, `${path}.mode`),
      negotiationPhase: requiredString(profile.negotiationPhase, `${path}.negotiationPhase`),
      summary: requiredString(profile.summary, `${path}.summary`),
      fields: profile.fields,
      sampleInput: requiredRecord(profile.sampleInput, `${path}.sampleInput`),
      timing: {
        healthyMinSec: requiredNumber(timing.healthyMinSec, `${path}.timing.healthyMinSec`),
        healthyMaxSec: requiredNumber(timing.healthyMaxSec, `${path}.timing.healthyMaxSec`),
        hardTimeoutSec: requiredNumber(timing.hardTimeoutSec, `${path}.timing.hardTimeoutSec`),
        protocolFloorSec: requiredNumber(timing.protocolFloorSec, `${path}.timing.protocolFloorSec`),
      },
      confirmationGates: profile.confirmationGates as string[],
      implementationStatus: requiredString(profile.implementationStatus, `${path}.implementationStatus`),
      executable: profile.executable,
      reasons: profile.reasons as string[],
    };
  });
}

export function procurementProfileCard(profile: ProcurementProfile): AgentCard {
  const name = PROFILE_AGENT_NAMES[profile.id];
  if (!name) throw new ButlerContractError(`procurement profile ${profile.id}`, "a supported live demo profile");
  return {
    name,
    label: profile.agentName,
    summary: profile.summary,
    tags: [profile.mode, profile.serviceId],
    exampleGoal: profile.title,
    exampleInput: profile.sampleInput,
    mode: profile.mode,
    input: profile.fields,
  };
}

export function parseProcurementJob(value: unknown): ProcurementJob {
  const job = requiredRecord(value, "procurement job");
  if (job.status !== "running" && job.status !== "complete" && job.status !== "failed") {
    throw new ButlerContractError("procurement job.status", '"running", "complete", or "failed"');
  }
  if (!Array.isArray(job.events)) throw new ButlerContractError("procurement job.events", "an array");
  const events = job.events.map((value, index) => {
    const path = `procurement job.events[${index}]`;
    const event = requiredRecord(value, path);
    return {
      phase: requiredString(event.phase, `${path}.phase`),
      label: requiredString(event.label, `${path}.label`),
      at: requiredString(event.at, `${path}.at`),
      txRef: optionalString(event.txRef, `${path}.txRef`),
      anchorRef: optionalString(event.anchorRef, `${path}.anchorRef`),
    };
  });
  if (job.status === "complete") requiredRecord(job.result, "procurement job.result");
  if (job.failedBeforePayment !== undefined && typeof job.failedBeforePayment !== "boolean") {
    throw new ButlerContractError("procurement job.failedBeforePayment", "a boolean");
  }
  return {
    id: requiredString(job.id, "procurement job.id"),
    status: job.status,
    phase: requiredString(job.phase, "procurement job.phase"),
    events,
    result: job.result,
    error: optionalString(job.error, "procurement job.error"),
    failedBeforePayment: job.failedBeforePayment,
  };
}

function optionalNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  return requiredNumber(value, path);
}

function parseOutputReceipt(value: unknown, path: string): OutputReceipt {
  const receipt = requiredRecord(value, path);
  if (receipt.status !== "queued" && receipt.status !== "anchoring" && receipt.status !== "broadcast" && receipt.status !== "confirmed" && receipt.status !== "failed") {
    throw new ButlerContractError(`${path}.status`, '"queued", "anchoring", "broadcast", "confirmed", or "failed"');
  }
  return {
    receiptId: optionalString(receipt.receiptId, `${path}.receiptId`),
    statusUrl: optionalString(receipt.statusUrl, `${path}.statusUrl`),
    status: receipt.status,
    attempts: optionalNumber(receipt.attempts, `${path}.attempts`),
    createdAt: optionalString(receipt.createdAt, `${path}.createdAt`),
    updatedAt: optionalString(receipt.updatedAt, `${path}.updatedAt`),
    digest: requiredString(receipt.digest, `${path}.digest`),
    anchorAddress: requiredString(receipt.anchorAddress, `${path}.anchorAddress`),
    anchorName: optionalString(receipt.anchorName, `${path}.anchorName`),
    scheme: optionalString(receipt.scheme, `${path}.scheme`),
    committedBy: optionalString(receipt.committedBy, `${path}.committedBy`),
    txRef: optionalString(receipt.txRef, `${path}.txRef`),
    error: optionalString(receipt.error, `${path}.error`),
    note: requiredString(receipt.note, `${path}.note`),
  };
}

export function parseReceiptEnvelope(value: unknown): OutputReceipt {
  const response = requiredRecord(value, "receipt response");
  return parseOutputReceipt(response.outputAttestation, "receipt response.outputAttestation");
}

export function parseButlerRun(value: unknown): ButlerRun {
  const response = requiredRecord(value, "Butler response");
  const butler = requiredRecord(response.butler, "Butler response.butler");
  requiredString(butler.selectedAgent, "Butler response.butler.selectedAgent");
  requiredString(butler.label, "Butler response.butler.label");
  if (!("result" in response)) throw new ButlerContractError("Butler response.result", "an agent result");
  let execution: ButlerRun["execution"];
  if (response.execution !== undefined) {
    const rawExecution = requiredRecord(response.execution, "Butler response.execution");
    execution = {
      requestId: requiredString(rawExecution.requestId, "Butler response.execution.requestId"),
      durationMs: requiredNumber(rawExecution.durationMs, "Butler response.execution.durationMs"),
    };
  }
  const outputAttestation = response.outputAttestation === undefined
    ? undefined
    : parseOutputReceipt(response.outputAttestation, "Butler response.outputAttestation");
  return { ...response, result: response.result, execution, outputAttestation };
}

/**
 * The gateway has published two negotiation-signature shapes: a bare
 * signature string, and the structured `{ party, algorithm, value }` record.
 * Either counts as present when it carries a non-empty signature value.
 */
function signaturePresent(value: unknown): boolean {
  if (typeof value === "string") return Boolean(value.trim());
  const structured = record(value);
  return typeof structured.value === "string" && Boolean(structured.value.trim());
}

export function procurementEvidence(value: unknown, mode = "rfq"): ProcurementEvidence {
  const report = record(value);
  const settlement = record(report.settlement);
  const negotiation = record(report.negotiation);
  const delivery = record(report.delivery);
  const evaluation = record(report.evaluation);
  const ruling = record(evaluation.ruling);
  const bundles = record(report.bundleVerification);
  const reconciliation = record(report.reconciliation);
  const anchors = record(report.anchors);
  const transactions = Array.isArray(report.transactions) ? report.transactions.map(record) : [];
  const paymentHash = typeof settlement.txHash === "string" ? settlement.txHash.trim() : "";
  const paymentRecorded = Boolean(paymentHash) && transactions.some((transaction) =>
    transaction.kind === "payment" && transaction.txRef === paymentHash,
  );
  const statusAccepted = report.status === "settled-and-accepted" || report.status === "recovered-after-terminal-abort";
  const negotiationSigned = signaturePresent(negotiation.buyerSignature) && signaturePresent(negotiation.sellerSignature);
  // Fixed-price flows publish the jointly-signed agreement as the anchored
  // agreement/commitment pair rather than projecting both raw signatures into
  // the result envelope. DACS-5 bundle verification then binds that agreement
  // into the two-party receipt set. RFQ stays fail-closed on both signatures.
  const fixedAgreementAnchored = mode.startsWith("fixed-price-")
    && negotiation.protocol === "dacs-fixed/1"
    && typeof negotiation.agreementHash === "string" && Boolean(negotiation.agreementHash.trim())
    && typeof anchors.agreement === "string" && Boolean(anchors.agreement.trim())
    && typeof anchors.commitment === "string" && Boolean(anchors.commitment.trim());
  const negotiationVerified = negotiationSigned || fixedAgreementAnchored;
  const deliveryVerified = delivery.verified === true && Object.keys(record(delivery.report)).length > 0;
  const bundlesVerified = bundles.ok === true;
  const reconciled = reconciliation.reconciled === true;
  const rulingValid = evaluation.rulingValid === true;
  const rulingAccepted = evaluation.accepted === true && ruling.verdict === "accept";
  const rulingRequired = mode === "rfq";
  return {
    statusAccepted,
    paymentRecorded,
    negotiationSigned,
    negotiationVerified,
    deliveryVerified,
    bundlesVerified,
    reconciled,
    rulingValid,
    rulingAccepted,
    rulingRequired,
    overallAccepted: statusAccepted && paymentRecorded && negotiationVerified && deliveryVerified && bundlesVerified && reconciled
      && (!rulingRequired || (rulingValid && rulingAccepted)),
  };
}
