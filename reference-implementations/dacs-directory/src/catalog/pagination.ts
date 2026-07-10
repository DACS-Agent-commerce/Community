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
