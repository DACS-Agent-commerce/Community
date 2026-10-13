/** Demos SR-2 is capped at 128 KiB; leave room for JSON encoding and metadata. */
export const MAX_ARTIFACT_BYTES = 256 * 1024;
export const MAX_STORAGE_RESPONSE_BYTES = 1024 * 1024;
export const MAX_ARTIFACT_DEPTH = 128;
export const MAX_STORAGE_OWNER_LENGTH = 512;
export const MAX_STORAGE_NAME_LENGTH = 1024;

/** Iterative preflight bounds depth and work before either recursive serializer. */
export function boundedJson(value: unknown, maxBytes = MAX_ARTIFACT_BYTES): string | null {
  try {
    const pending: Array<{ values: Iterator<unknown>; depth: number }> = [
      { values: [value][Symbol.iterator](), depth: 0 },
    ];
    let minimumBytes = 0;
    while (pending.length) {
      const frame = pending[pending.length - 1];
      const next = frame.values.next();
      if (next.done) { pending.pop(); continue; }
      const v = next.value;
      if (v !== null && typeof v === "object") {
        const depth = frame.depth + 1;
        if (depth > MAX_ARTIFACT_DEPTH) return null;
        minimumBytes += 2;
        const children = function* (): Generator<unknown> {
          if (Array.isArray(v)) {
            for (const item of v) { minimumBytes++; yield item; }
          } else {
            for (const key of Object.keys(v)) {
              minimumBytes += Buffer.byteLength(key, "utf8") + 4;
              yield (v as Record<string, unknown>)[key];
            }
          }
        };
        pending.push({ values: children(), depth });
      } else {
        minimumBytes += typeof v === "string" ? Buffer.byteLength(v, "utf8") + 2 : 1;
      }
      if (minimumBytes > maxBytes) return null;
    }
    const json = JSON.stringify(value);
    return typeof json === "string" && Buffer.byteLength(json, "utf8") <= maxBytes ? json : null;
  } catch { return null; }
}

export class StorageResponseTooLarge extends Error {}

/** Bound bytes as they arrive; never call Response.json() on storage reads. */
export async function storageResponseJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing storage response body");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_STORAGE_RESPONSE_BYTES) {
        await reader.cancel();
        throw new StorageResponseTooLarge("storage response exceeds byte ceiling");
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } finally { reader.releaseLock(); }
}
