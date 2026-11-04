import { admitRawJson, RawJsonAdmissionError } from "@kynesyslabs/dacs/canonical";

/**
 * A DACS artifact must fit the substrate's 128 KB storage soft cap (DACS-5 §10.4.2, DEMOS-MAPPING
 * SR-2); a larger session uses the extended-pointer pattern, which this indexer does not follow.
 */
export const MAX_DACS_ARTIFACT_BYTES = 128 * 1024;
/** Ceiling on a stored payload's JSON, with room above the DACS cap for encoding and metadata. */
export const MAX_ARTIFACT_BYTES = 256 * 1024;
/**
 * Independent directory policy for the complete storage response envelope.
 * The node's 1 MiB payload cap does not bound its response metadata or encoding.
 */
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

/**
 * JSON.parse for text read from the network. CORE §B.2 admits `-0` and serializes it as `0`, but
 * the SDK's data-only check refuses it, which would drop a correctly signed artifact. Reading it
 * as `0` leaves every canonical byte unchanged. The walk is iterative: a reviver recurses, and a
 * deeply nested reply must stay a bounded rejection, not a stack overflow.
 */
export function parseWireJson(text: string): unknown {
  return readNegativeZeroAsZero(JSON.parse(text) as unknown);
}

function readNegativeZeroAsZero(root: unknown): unknown {
  const pending: unknown[] = [root];
  while (pending.length) {
    const node = pending.pop();
    if (node === null || typeof node !== "object") continue;
    const members = node as Record<string, unknown>;
    for (const key of Object.keys(members)) {
      if (Object.is(members[key], -0)) members[key] = 0;
      else pending.push(members[key]);
    }
  }
  return Object.is(root, -0) ? 0 : root;
}

/**
 * A storage-program reply read on its received bytes. `refusal` is set when the SDK's CORE §B.2
 * CF-5 raw admission (duplicate members, UTF-8, number profile) refused the bytes; `reply` is then
 * the plain parse, kept only so the caller can record bounded metadata, and its `data` must not be
 * used.
 */
export interface StorageArtifactReply {
  reply: unknown;
  refusal?: RawJsonAdmissionError;
}

/**
 * Admits the exact received bytes before JSON.parse, which cannot see duplicate members or
 * number spellings. Throws a SyntaxError when the bytes are not JSON at all; it carries the SDK
 * error as `cause` when the SDK refused the bytes (a reply that never closes has no cause). The check covers the whole reply, so the reply object counts as one of the 128
 * nesting levels CF-5 admits: a stored artifact may nest 127 levels.
 */
function admitStorageArtifactReply(bytes: Buffer): StorageArtifactReply {
  try {
    return { reply: readNegativeZeroAsZero(admitRawJson(bytes, { maxBytes: MAX_STORAGE_RESPONSE_BYTES })) };
  } catch (error) {
    if (!(error instanceof RawJsonAdmissionError)) throw error;
    if (error.stage === "parse") throw new SyntaxError(`storage response is not valid JSON: ${error.code}`, { cause: error });
    return { reply: parseWireJson(bytes.toString("utf8")), refusal: error };
  }
}

/** Bound bytes as they arrive; never call Response.json() on storage reads. */
async function storageResponseBytes(response: Response): Promise<Buffer> {
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
    return Buffer.concat(chunks, bytes);
  } finally { reader.releaseLock(); }
}

/** Bounded read of a node reply that carries no stored artifact (RPC envelopes, probes). */
export async function storageResponseJson(response: Response): Promise<unknown> {
  return parseWireJson((await storageResponseBytes(response)).toString("utf8"));
}

/**
 * Bounded read of a storage-program reply whose `data` is an artifact, admitted on its received
 * bytes. Throws StorageResponseTooLarge past the byte ceiling and a SyntaxError for non-JSON.
 */
export async function storageArtifactResponseJson(response: Response): Promise<StorageArtifactReply> {
  return admitStorageArtifactReply(await storageResponseBytes(response));
}
