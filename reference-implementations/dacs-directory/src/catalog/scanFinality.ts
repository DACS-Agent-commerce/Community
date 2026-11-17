/**
 * Finality rule shared by the chain scanner and the status report.
 *
 * A transaction is final when it is `depth` transactions behind the newest one,
 * or when the newest transaction id has stayed the same for at least `seconds`
 * of this process's own time. The depth rule protects a busy chain, where the
 * newest id keeps changing; the observation rule lets the newest transactions
 * of a quiet chain be indexed without waiting for new traffic. Transaction
 * timestamps are set by the sender and play no part in either rule.
 */

export const DEFAULT_FINALITY_DEPTH = 2;
/**
 * Five minutes is well past the depth rule's usual wait on an active chain and
 * short enough that a Listing published as the last transaction appears in the
 * catalog within one or two indexing passes.
 */
export const DEFAULT_FINALITY_SECONDS = 300;
/** Newest transactions that are read to apply the rule; a depth this large is decided by depth alone. */
export const MAX_FINALITY_WINDOW = 100;

export interface FinalityRule {
  /** Transactions behind the newest one that are final regardless of observation time. */
  depth: number;
  /** Seconds the newest transaction id must have been observed unchanged before it is final. */
  seconds: number;
}

/** A transaction row as far as the rule reads it. */
export interface FinalityTransaction {
  id?: unknown;
}

const integerAtLeast = (raw: string | undefined, minimum: number, fallback: number): number => {
  const parsed = Number(raw);
  return raw !== undefined && Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
};

/**
 * Read the rule from `DACS_SCAN_FINALITY_DEPTH` (a non-negative integer, default 2)
 * and `DACS_SCAN_FINALITY_SECONDS` (a positive integer, default 300). Unset or
 * invalid values use the default.
 */
export function finalityRule(): FinalityRule {
  return {
    depth: integerAtLeast(process.env.DACS_SCAN_FINALITY_DEPTH, 0, DEFAULT_FINALITY_DEPTH),
    seconds: integerAtLeast(process.env.DACS_SCAN_FINALITY_SECONDS, 1, DEFAULT_FINALITY_SECONDS),
  };
}

/** The newest transaction id this process has seen and the local time it first saw that id. */
let observedTip: { id: number; since: number } | null = null;

/**
 * Record that `tip` is the newest transaction id at local time `now` and return
 * how many milliseconds this process has seen that same id as the newest. A
 * different id, or a clock that moved backwards, restarts the count. The record
 * is kept in memory only, so a restart begins the count again and can only delay
 * finality.
 */
export function observeTip(tip: number, now: number = Date.now()): number {
  if (observedTip === null || observedTip.id !== tip || now < observedTip.since) observedTip = { id: tip, since: now };
  return now - observedTip.since;
}

/** Forget the recorded newest id. */
export function resetTipObservation(): void {
  observedTip = null;
}

/**
 * Highest id that is final, given only the newest id `tip` and how long it has
 * been observed unchanged. The tip itself is final once `tipUnchangedMs`
 * reaches the rule's seconds; otherwise only ids `depth` behind it are.
 */
export function settledFromTip(tip: number, rule: FinalityRule, tipUnchangedMs: number): number {
  const depthTip = Math.max(0, tip - rule.depth);
  return tipUnchangedMs >= rule.seconds * 1_000 ? Math.max(0, tip) : depthTip;
}

/**
 * Highest transaction id such that it and every lower id is final, given the
 * newest transactions in `newest`, the id of the newest one, `tip`, and how long
 * that id has been observed unchanged.
 *
 * Going past the depth boundary needs every id from the boundary up to the
 * final one to be present among `newest`, so an id missing from the rows read
 * stops the result just below it. When `depth` reaches the rows that can be read
 * the depth rule alone decides.
 */
export function settledTip(
  newest: readonly FinalityTransaction[],
  tip: number,
  rule: FinalityRule,
  tipUnchangedMs: number,
): number {
  const depthTip = Math.max(0, tip - rule.depth);
  const upper = settledFromTip(tip, rule, tipUnchangedMs);
  if (upper <= depthTip || tip - depthTip >= MAX_FINALITY_WINDOW) return depthTip;
  const ids = new Set<number>();
  for (const tx of newest) {
    if (typeof tx === "object" && tx !== null && typeof tx.id === "number" && Number.isSafeInteger(tx.id)) ids.add(tx.id);
  }
  for (let id = depthTip + 1; id <= upper; id++) {
    if (!ids.has(id) || !ids.has(id - 1)) return id - 1;
  }
  return upper;
}
