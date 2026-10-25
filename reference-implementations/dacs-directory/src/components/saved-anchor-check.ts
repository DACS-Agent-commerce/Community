/** Deadline for one read of the saved anchor through the artifact route. */
export const SAVED_ANCHOR_CHECK_TIMEOUT_MS = 15_000;

/**
 * One check of a saved anchor. `present`, `absent` and `invalid` are the node's own
 * answers. `unavailable` means the read is indeterminate and says why.
 */
export type SavedAnchorCheck =
  | { status: "present" | "absent" | "invalid" }
  | { status: "unavailable"; reason: "timeout" | "failed" | "malformed" };

const MALFORMED: SavedAnchorCheck = { status: "unavailable", reason: "malformed" };

function parseArtifactReply(body: unknown): SavedAnchorCheck {
  if (!body || typeof body !== "object") return MALFORMED;
  const { status, value } = body as { status?: unknown; value?: unknown };
  if (status === "present") {
    return value && typeof value === "object" && !Array.isArray(value) ? { status } : MALFORMED;
  }
  return (status === "absent" || status === "invalid") && value === null ? { status } : MALFORMED;
}

/**
 * Reads the saved anchor through `/api/dacs/artifact` within the deadline. Never throws:
 * a failed request, a missed deadline and a reply that is not a status-bearing artifact
 * answer are each returned as `unavailable` with their own reason.
 */
export async function readSavedAnchorStatus(anchorAddress: string): Promise<SavedAnchorCheck> {
  try {
    const response = await fetch(`/api/dacs/artifact?ref=${encodeURIComponent(anchorAddress)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(SAVED_ANCHOR_CHECK_TIMEOUT_MS),
    });
    if (!response.ok) return { status: "unavailable", reason: "failed" };
    return parseArtifactReply(await response.json());
  } catch (error) {
    if (error instanceof SyntaxError) return MALFORMED;
    return { status: "unavailable", reason: error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "failed" };
  }
}

const CHECK_MESSAGES = {
  present: "The node reports data at the saved anchor. This read does not verify its signatures or finality. Discarding this local record will not withdraw it.",
  absent: "The node reports no readable data at the saved anchor. The earlier send may still have succeeded or may become visible later.",
  invalid: "The node holds content at the saved anchor that is not a listing artifact. This read does not verify signatures or finality.",
  timeout: "The saved anchor check timed out. Try again before discarding recovery data.",
  failed: "The saved anchor could not be checked. Try again before discarding recovery data.",
  malformed: "The saved anchor check returned a reply that could not be read. Try again before discarding recovery data.",
} as const;

/** The message shown for a saved anchor check. */
export function describeSavedAnchorCheck(check: SavedAnchorCheck): string {
  return CHECK_MESSAGES[check.status === "unavailable" ? check.reason : check.status];
}

/** Whether a check answered definitively, so discarding the saved record may be offered. */
export function savedAnchorAllowsDiscard(check: SavedAnchorCheck): boolean {
  return check.status !== "unavailable";
}
