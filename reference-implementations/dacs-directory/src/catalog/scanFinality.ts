/**
 * Finality rule shared by the chain scanner and the status report.
 *
 * A transaction is final when it is `depth` transactions behind the newest one,
 * or when its own timestamp is at least `seconds` old and is not itself far
 * older than the transaction below it. The depth rule protects a busy chain;
 * the age rule lets the newest transactions of a quiet chain be indexed without
 * waiting for new traffic. After a quiet chain gets a new transaction, the
 * status report can show a stalled cursor until the next indexing pass.
 */

export const DEFAULT_FINALITY_DEPTH = 2;
/**
 * Five minutes is well past the depth rule's usual wait on an active chain and
 * short enough that a Listing published as the last transaction appears in the
 * catalog within one or two indexing passes.
 */
export const DEFAULT_FINALITY_SECONDS = 300;
/** Newest transactions that must be read to apply the rule; deeper ones are final by depth alone. */
export const MAX_FINALITY_WINDOW = 100;

export interface FinalityRule {
  /** Transactions behind the newest one that are final regardless of age. */
  depth: number;
  /** Age in seconds at which a transaction with a valid timestamp is final. */
  seconds: number;
  /** Current time in milliseconds. */
  now: number;
}

/** A transaction row as far as the rule reads it. */
export interface FinalityTransaction {
  id?: unknown;
  timestamp?: unknown;
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
export function finalityRule(now: number = Date.now()): FinalityRule {
  return {
    depth: integerAtLeast(process.env.DACS_SCAN_FINALITY_DEPTH, 0, DEFAULT_FINALITY_DEPTH),
    seconds: integerAtLeast(process.env.DACS_SCAN_FINALITY_SECONDS, 1, DEFAULT_FINALITY_SECONDS),
    now,
  };
}

/** The transaction's timestamp in milliseconds, or null when it has no valid one. */
function timestampMs(tx: FinalityTransaction): number | null {
  const raw = tx.timestamp;
  const value = typeof raw === "string" && /^\d{1,16}$/.test(raw) ? Number(raw) : raw;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Number of newest transactions to read so that the one below the depth boundary is included. */
export function finalityWindow(rule: FinalityRule): number {
  return Math.min(rule.depth + 1, MAX_FINALITY_WINDOW);
}

/**
 * Highest transaction id such that it and every lower id is final, given the
 * newest transactions in `newest` and the id of the newest one, `tip`.
 *
 * A held-back transaction stops the result just below it, so an old transaction
 * above a recent one never moves the cursor past the recent one. A transaction
 * without a valid timestamp is held back unless the depth rule makes it final,
 * and so is an id that is missing from the newest transactions.
 *
 * The sender sets a transaction's timestamp, so a stale one could pass for old.
 * The age rule therefore applies only to a transaction whose timestamp is not
 * more than `seconds` older than that of the transaction just below it; a
 * transaction signed long before it reached the chain waits for the depth rule.
 * When `newest` does not reach back to the depth boundary the age rule cannot
 * be applied to the ids it skips, and the depth rule alone decides.
 */
export function settledTip(newest: readonly FinalityTransaction[], tip: number, rule: FinalityRule): number {
  const depthTip = Math.max(0, tip - rule.depth);
  const byId = new Map<number, FinalityTransaction>();
  for (const tx of newest) {
    if (typeof tx !== "object" || tx === null) continue;
    if (typeof tx.id === "number" && Number.isSafeInteger(tx.id)) byId.set(tx.id, tx);
  }
  const lowestOnPage = byId.size ? Math.min(...byId.keys()) : Infinity;
  if (lowestOnPage > depthTip + 1 || tip - depthTip >= MAX_FINALITY_WINDOW) return Math.max(0, Math.min(depthTip, tip));
  const limit = rule.seconds * 1_000;
  let lowestHeldBack = Infinity;
  for (let id = depthTip + 1; id <= tip; id++) {
    const tx = byId.get(id);
    const timestamp = tx ? timestampMs(tx) : null;
    const below = byId.get(id - 1);
    const belowTimestamp = below ? timestampMs(below) : null;
    const old = timestamp !== null && rule.now - timestamp >= limit;
    const signedOnTime = timestamp !== null && belowTimestamp !== null && belowTimestamp - timestamp <= limit;
    if (!(old && signedOnTime)) {
      lowestHeldBack = id;
      break;
    }
  }
  return Math.max(0, Math.min(tip, lowestHeldBack - 1));
}
