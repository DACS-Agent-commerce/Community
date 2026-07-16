export type AgentCard = {
  name: string;
  label: string;
  summary: string;
  tags: string[];
  exampleGoal: string;
  exampleInput: Record<string, unknown>;
};

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
};

export type ProcurementEvidence = {
  statusAccepted: boolean;
  paymentRecorded: boolean;
  negotiationSigned: boolean;
  deliveryVerified: boolean;
  bundlesVerified: boolean;
  reconciled: boolean;
  rulingValid: boolean;
  rulingAccepted: boolean;
  overallAccepted: boolean;
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

export function parseAgentInput(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AgentInputError();
  return value as Record<string, unknown>;
}

export async function fetchJsonBeforeDeadline<T = unknown>(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  deadlineMs: number,
  fetcher: typeof fetch = fetch,
): Promise<{ response: Response; body: T }> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) throw new Error(PROCUREMENT_TIMEOUT_MESSAGE);
  const controller = new AbortController();
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
    if (deadlineExpired) throw new Error(PROCUREMENT_TIMEOUT_MESSAGE);
    throw cause;
  } finally {
    clearTimeout(timer);
  }
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
    };
  });
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
  return {
    id: requiredString(job.id, "procurement job.id"),
    status: job.status,
    phase: requiredString(job.phase, "procurement job.phase"),
    events,
    result: job.result,
    error: optionalString(job.error, "procurement job.error"),
  };
}

export function parseButlerRun(value: unknown): Record<string, unknown> {
  const response = requiredRecord(value, "Butler response");
  const butler = requiredRecord(response.butler, "Butler response.butler");
  requiredString(butler.selectedAgent, "Butler response.butler.selectedAgent");
  requiredString(butler.label, "Butler response.butler.label");
  if (!("result" in response)) throw new ButlerContractError("Butler response.result", "an agent result");
  return response;
}

export function procurementEvidence(value: unknown): ProcurementEvidence {
  const report = record(value);
  const settlement = record(report.settlement);
  const negotiation = record(report.negotiation);
  const delivery = record(report.delivery);
  const evaluation = record(report.evaluation);
  const ruling = record(evaluation.ruling);
  const bundles = record(report.bundleVerification);
  const reconciliation = record(report.reconciliation);
  const transactions = Array.isArray(report.transactions) ? report.transactions.map(record) : [];
  const paymentHash = typeof settlement.txHash === "string" ? settlement.txHash.trim() : "";
  const paymentRecorded = Boolean(paymentHash) && transactions.some((transaction) =>
    transaction.kind === "payment" && transaction.txRef === paymentHash,
  );
  const statusAccepted = report.status === "settled-and-accepted" || report.status === "recovered-after-terminal-abort";
  const negotiationSigned = typeof negotiation.buyerSignature === "string" && Boolean(negotiation.buyerSignature.trim())
    && typeof negotiation.sellerSignature === "string" && Boolean(negotiation.sellerSignature.trim());
  const deliveryVerified = delivery.verified === true && Object.keys(record(delivery.report)).length > 0;
  const bundlesVerified = bundles.ok === true;
  const reconciled = reconciliation.reconciled === true;
  const rulingValid = evaluation.rulingValid === true;
  const rulingAccepted = evaluation.accepted === true && ruling.verdict === "accept";
  return {
    statusAccepted,
    paymentRecorded,
    negotiationSigned,
    deliveryVerified,
    bundlesVerified,
    reconciled,
    rulingValid,
    rulingAccepted,
    overallAccepted: statusAccepted && paymentRecorded && negotiationSigned && deliveryVerified && bundlesVerified && reconciled && rulingValid && rulingAccepted,
  };
}
