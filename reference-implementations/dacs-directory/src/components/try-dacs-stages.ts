import type { ProcurementEvent } from "./try-dacs-contract.js";

/**
 * Pure helpers behind the /try DACS-stage rail: mapping live gateway
 * procurement events onto the five DACS stages, computing fail-closed
 * progress, and (de)serialising the persisted procurement run record.
 */

/** Gateway procurement event phases → DACS stage index (0..4). */
export const PROCUREMENT_PHASE_STAGE: Record<string, number> = {
  queued: 0, connecting: 0, discovering: 0,
  selecting: 1,
  agreeing: 2,
  settling: 3, delivering: 3, recovering: 3,
  verifying: 4, evaluating: 4, complete: 4,
};

/**
 * Some gateway phases span two DACS stages (e.g. the RFQ opens and the
 * agreement anchors while the job phase is still "selecting"), so the event
 * label can override the phase for known-labelled milestones.
 */
function stageForLabel(label: string): number | undefined {
  const lowered = label.toLowerCase();
  if (/\bvet\b/.test(lowered)) return 1;
  if (/agreement|commitment|rfq|agreed/.test(lowered)) return 2;
  if (/settlement evidence|payment evidence/.test(lowered)) return 3;
  return undefined;
}

export type StagedEvents = {
  /** Events grouped by DACS stage index 0..4. */
  byStage: ProcurementEvent[][];
  /** Highest stage the run actually reached — never advanced by failures. */
  progress: number;
};

/**
 * Assign each event to a DACS stage and compute how far the run actually
 * progressed. Fails closed: a terminal "failed" event (or any unknown phase)
 * attaches to the stage the run had already reached and NEVER advances
 * progress — its error text is not label-matched, so a failure message that
 * happens to mention "agreement" cannot fake Negotiate progress.
 */
export function stageEvents(events: readonly ProcurementEvent[]): StagedEvents {
  const byStage: ProcurementEvent[][] = [[], [], [], [], []];
  let progress = 0;
  for (const event of events) {
    if (event.phase === "failed") {
      byStage[progress]!.push(event);
      continue;
    }
    const known = stageForLabel(event.label) ?? PROCUREMENT_PHASE_STAGE[event.phase];
    const stage = known ?? progress;
    byStage[stage]!.push(event);
    if (known !== undefined && known > progress) progress = known;
  }
  return { byStage, progress };
}

/**
 * The procurement run record persisted to localStorage so a reload cannot
 * lose the idempotency key of a dispatched purchase. Kept until the job
 * reaches a terminal state the browser has verified as safe (complete, or
 * failed with the gateway's explicit failedBeforePayment=true).
 */
export type StoredProcurementRun = {
  runId: string;
  jobId?: string;
  goal: string;
  input: Record<string, unknown>;
  startedAt: string;
};

/** Parse a persisted run record; null for anything malformed. */
export function parseStoredProcurementRun(raw: string | null): StoredProcurementRun | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const run = value as Record<string, unknown>;
    if (typeof run.runId !== "string" || !run.runId.trim()) return null;
    if (typeof run.goal !== "string") return null;
    if (typeof run.startedAt !== "string") return null;
    if (!run.input || typeof run.input !== "object" || Array.isArray(run.input)) return null;
    if (run.jobId !== undefined && typeof run.jobId !== "string") return null;
    return {
      runId: run.runId,
      jobId: typeof run.jobId === "string" ? run.jobId : undefined,
      goal: run.goal,
      input: run.input as Record<string, unknown>,
      startedAt: run.startedAt,
    };
  } catch {
    return null;
  }
}
