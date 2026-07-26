export const DEAD_LETTER_DEFAULT_LIMIT = 20;
export const DEAD_LETTER_MAX_LIMIT = 100;

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
