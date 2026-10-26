/**
 * The chain gate both catalog writers pass first: `reindexAll` and
 * POST /api/dacs/index-now. Nothing from a node outside the pinned chain, or
 * from a node that cannot be read, reaches the catalog or the scan state.
 */
import { catalogNodeDeployment } from "./listingFinality.js";
import { SCAN_STATE_SCHEMA_VERSION } from "./scanState.js";
import type { ScanState } from "./types.js";

/** Node-supplied text is cut to this many characters before it is logged or returned. */
const MAX_CAUSE_TEXT = 200;

/**
 * The gate's verdict. A refusal's `cause` is a stable code (NODE_TIMEOUT,
 * NODE_TRANSPORT, GENESIS_UNREADABLE or WRONG_CHAIN), then bounded text.
 */
export type ServedCatalogChain =
  | { ok: true; chainIdentity: string; warning: string | null }
  | { ok: false; status: 503 | 409; cause: string };

const causeText = (text: string) => text.replace(/[^\x20-\x7e]/g, "?").slice(0, MAX_CAUSE_TEXT);

function unreadableCode(error: unknown): string {
  if (!(error instanceof Error)) return "GENESIS_UNREADABLE";
  if (error.name === "TimeoutError" || error.name === "AbortError") return "NODE_TIMEOUT";
  // fetch rejects with "fetch failed"; nodeCall names a non-2xx answer "<call> transport failed".
  if (error.message === "fetch failed" || error.message.endsWith(" transport failed")) return "NODE_TRANSPORT";
  // The node answered, but with an error, a malformed or oversized reply, or a block naming no chain.
  return "GENESIS_UNREADABLE";
}

/**
 * Read the chain the configured node serves and check it against the pin.
 * Returns the served identity and any build-drift warning; 503 when the node
 * cannot be read, 409 when it serves another chain. Never throws.
 */
export async function servedCatalogChain(read: typeof catalogNodeDeployment = catalogNodeDeployment): Promise<ServedCatalogChain> {
  try {
    const deployment = await read();
    if (!deployment.ok) return { ok: false, status: 409, cause: `WRONG_CHAIN: ${causeText(deployment.reason)}` };
    return { ok: true, chainIdentity: deployment.chainIdentity, warning: deployment.warning };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 503, cause: `${unreadableCode(error)}: ${causeText(message)}` };
  }
}

/** True only when a complete pass on this chain, at the current schema, produced the scan state. */
export const scanStateCurrent = (state: ScanState, chainIdentity: string): boolean =>
  state.chainIdentity === chainIdentity && state.schemaVersion === SCAN_STATE_SCHEMA_VERSION;
