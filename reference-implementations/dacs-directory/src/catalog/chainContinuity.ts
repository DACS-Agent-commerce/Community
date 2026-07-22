import type { ScanState } from "./types.js";

const DEFAULT_RESET_THRESHOLD = 1_000;

export function chainResetThreshold(raw = process.env.DACS_SCAN_RESET_THRESHOLD): number {
  const parsed = Number(raw ?? DEFAULT_RESET_THRESHOLD);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_RESET_THRESHOLD;
}

export function cursorAheadBy(state: Pick<ScanState, "lastSeenTxId">, chainTip: number): number {
  return Math.max(0, state.lastSeenTxId - chainTip);
}

/**
 * Transaction ids may move backwards briefly while nodes converge. Only a
 * large regression is treated as a chain replacement and allowed to clear
 * the derived cache. The threshold is intentionally configurable for chains
 * with different reorganisation characteristics.
 */
export function chainResetRequired(
  state: Pick<ScanState, "lastSeenTxId" | "lastChainTip">,
  chainTip: number,
  threshold = chainResetThreshold(),
): boolean {
  if (!Number.isSafeInteger(chainTip) || chainTip < 0) return false;
  const cursorRegression = state.lastSeenTxId - chainTip;
  const priorCursorRegression = state.lastChainTip === undefined
    ? cursorRegression
    : state.lastSeenTxId - state.lastChainTip;
  return cursorRegression >= threshold && priorCursorRegression >= threshold;
}
