import type { ReachabilityHint } from "./types.js";

export const REACHABILITY_FRESH_MS = 60 * 60_000;

const REACHABILITY_STATUSES = new Set(["reachable", "unreachable", "unknown"]);

export const reachabilityHintIsFresh = (hint: ReachabilityHint | undefined, now: number): boolean =>
  Boolean(hint && REACHABILITY_STATUSES.has(hint.status) && Number.isSafeInteger(hint.checkedAt) &&
    hint.checkedAt >= 0 && hint.checkedAt <= now && now - hint.checkedAt <= REACHABILITY_FRESH_MS);

/** A missing or stale observation is explicitly unknown to rendering consumers. */
export function effectiveReachabilityStatus(
  hint: ReachabilityHint | undefined,
  now = Date.now(),
): ReachabilityHint["status"] {
  return reachabilityHintIsFresh(hint, now) ? hint!.status : "unknown";
}
