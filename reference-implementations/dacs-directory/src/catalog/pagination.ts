export type PaginationResult =
  | { ok: true; limit: number; cursor: number }
  | { ok: false; error: string };

export function parsePagination(limitRaw: string | null, cursorRaw: string | null): PaginationResult {
  const limit = limitRaw === null ? 50 : Number(limitRaw);
  const cursor = cursorRaw === null ? 0 : Number(cursorRaw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    return { ok: false, error: "limit must be an integer from 1 to 200" };
  }
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    return { ok: false, error: "cursor must be a non-negative integer" };
  }
  return { ok: true, limit, cursor };
}

const BINDING_KEY = /^[0-9a-f]{64}$/;

export type BindingPageRequest =
  | { ok: true; limit: number | undefined; after: string | undefined }
  | { ok: false; error: string };

/**
 * Reads the optional `limit` and `cursor` of the bundle-binding route. Neither is required: with no
 * `limit` the whole set (after `cursor`, when given) is wanted. The cursor is a binding content hash
 * (64 lowercase hex digits). Returns `ok: false` with the 400 message for a bad `limit` or `cursor`.
 */
export function parseBindingPage(limitRaw: string | null, cursorRaw: string | null): BindingPageRequest {
  if (cursorRaw !== null && !BINDING_KEY.test(cursorRaw)) {
    return { ok: false, error: "cursor must be a binding content hash of 64 lowercase hex digits" };
  }
  const after = cursorRaw ?? undefined;
  if (limitRaw === null) return { ok: true, limit: undefined, after };
  const sized = parsePagination(limitRaw, null);
  return sized.ok ? { ok: true, limit: sized.limit, after } : sized;
}

/**
 * Keyset page over entries ordered by their string key: the entries whose key sorts after `after`
 * (all of them when `after` is absent), at most `limit` of them (the whole remainder when `limit` is
 * absent). `after` need not name a current entry. `next` is the last key served, present only when
 * more entries remain after this page.
 */
export function keysetPage<T>(
  entries: readonly { key: string; value: T }[],
  { limit, after }: { limit: number | undefined; after: string | undefined },
): { values: T[]; next: string | undefined } {
  const ordered = [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const remaining = after === undefined ? ordered : ordered.filter((entry) => entry.key > after);
  const page = limit === undefined ? remaining : remaining.slice(0, limit);
  return {
    values: page.map((entry) => entry.value),
    next: page.length < remaining.length ? page[page.length - 1].key : undefined,
  };
}
