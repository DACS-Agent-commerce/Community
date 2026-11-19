export const DEAD_LETTER_DEFAULT_LIMIT = 20;
export const DEAD_LETTER_MAX_LIMIT = 100;
export const CURSOR_STALL_MIN_SECONDS = 5 * 60;
export const CURSOR_STALL_MAX_SECONDS = 24 * 60 * 60;
export const INDEX_INTERVAL_DEFAULT_SECONDS = 15 * 60;
export const INDEX_INTERVAL_MAX_SECONDS = 12 * 60 * 60;

export type StatusDiagnosticsQuery =
  | { ok: true; deadLetterLimit: number; deadLetterLocator?: string }
  | { ok: false; error: string };

/** Parse the bounded public diagnostics controls used by /api/dacs/status. */
export function parseStatusDiagnosticsQuery(params: URLSearchParams): StatusDiagnosticsQuery {
  const rawLimit = params.get("deadLetterLimit");
  const deadLetterLimit = rawLimit === null ? DEAD_LETTER_DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(deadLetterLimit) || deadLetterLimit < 1 || deadLetterLimit > DEAD_LETTER_MAX_LIMIT) {
    return { ok: false, error: `deadLetterLimit must be an integer from 1 to ${DEAD_LETTER_MAX_LIMIT}` };
  }

  const rawLocator = params.get("locator");
  if (rawLocator === null) return { ok: true, deadLetterLimit };
  const deadLetterLocator = rawLocator.trim();
  if (!/^stor-[0-9a-f]{40}$/.test(deadLetterLocator)) {
    return { ok: false, error: "locator must be a lowercase stor- address" };
  }
  return { ok: true, deadLetterLimit, deadLetterLocator };
}

export function cursorStallThresholdSeconds(
  raw = process.env.DACS_CURSOR_STALL_SECONDS,
  rawIndexInterval = process.env.DACS_INDEX_INTERVAL_SECONDS,
): number {
  const indexInterval = Number(rawIndexInterval ?? INDEX_INTERVAL_DEFAULT_SECONDS);
  const boundedInterval = Number.isSafeInteger(indexInterval) && indexInterval >= 1 && indexInterval <= INDEX_INTERVAL_MAX_SECONDS
    ? indexInterval
    : INDEX_INTERVAL_DEFAULT_SECONDS;
  const scheduleAwareDefault = Math.min(
    CURSOR_STALL_MAX_SECONDS,
    Math.max(CURSOR_STALL_MIN_SECONDS, boundedInterval * 2),
  );
  if (raw === undefined) return scheduleAwareDefault;
  const configured = Number(raw);
  return Number.isSafeInteger(configured) && configured >= 1 && configured <= CURSOR_STALL_MAX_SECONDS
    ? configured
    : scheduleAwareDefault;
}

/**
 * Cursor progress against the settled tip, the newest id the scanner is allowed
 * to index (see `settledFromTip`). The cursor is stalled only when it is behind
 * the settled tip and the cursor has not advanced for at least the threshold;
 * transactions still waiting to become final are not a stall. `cursorStalled`
 * is null when the settled tip or the time of the last advance is unknown.
 *
 * `finalAfter` says that the ids above `aboveId` became final only at `atMs`
 * (local time), when the tip had been unchanged long enough. If the cursor is
 * already at `aboveId` or beyond, the stall count starts at the later of the
 * last advance and `atMs`, so a transaction that has only just become final is
 * not a stall until the threshold has passed since it did.
 */
export function cursorProgressDiagnostics(
  scan: { lastSeenTxId: number; cursorAdvancedAt?: number },
  settledTip: number | null,
  now = Date.now(),
  stallThresholdSeconds = cursorStallThresholdSeconds(),
  finalAfter?: { aboveId: number; atMs: number },
): {
  cursorAdvancedAt: number | null;
  secondsSinceCursorAdvanced: number | null;
  cursorStallThresholdSeconds: number;
  cursorStalled: boolean | null;
} {
  const cursorAdvancedAt = typeof scan.cursorAdvancedAt === "number"
    ? scan.cursorAdvancedAt
    : null;
  const secondsSinceCursorAdvanced = cursorAdvancedAt === null
    ? null
    : Math.max(0, Math.floor((now - cursorAdvancedAt) / 1_000));
  const stallStart = cursorAdvancedAt !== null && finalAfter !== undefined && scan.lastSeenTxId >= finalAfter.aboveId
    ? Math.max(cursorAdvancedAt, finalAfter.atMs)
    : cursorAdvancedAt;
  const secondsStalled = stallStart === null ? null : Math.max(0, Math.floor((now - stallStart) / 1_000));
  const cursorStalled = settledTip === null
    ? null
    : settledTip <= scan.lastSeenTxId
      ? false
      : secondsStalled === null
        ? null
        : secondsStalled >= stallThresholdSeconds;
  return {
    cursorAdvancedAt,
    secondsSinceCursorAdvanced,
    cursorStallThresholdSeconds: stallThresholdSeconds,
    cursorStalled,
  };
}
