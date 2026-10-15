/**
 * Read-only probe of the node RPC contract the Directory depends on (README "Node deployment
 * contract"). It sends no transactions: one storage GET for an address no program occupies, and the
 * exact-name program search over both the deployed nodeCall and the pinned revision's gcr_routine.
 * Each search observation is dated runtime evidence, not a pin.
 */
import { storageResponseJson } from "./artifactLimits.js";
import { UNKNOWN_NODE_CALL } from "./chain.js";
import { gcrAuthHeaders } from "./gcr.js";

export interface NodeContractReport {
  rpc: string;
  observedAt: string;
  /** The node's own not-found answer for an unoccupied address: 404 with errorCode NOT_FOUND. */
  storageNotFound: boolean;
  nodeCallSearch: "supported" | "unknown-message" | "failed";
  gcrRoutineSearch: "supported" | "failed";
  /** Both searches answered and named the same programs for the exact name. */
  searchesAgree: boolean | null;
  ok: boolean;
}

const UNOCCUPIED = `stor-${"0".repeat(40)}`;

async function post(rpc: string, headers: Record<string, string>, payload: unknown): Promise<unknown> {
  try {
    const response = await fetch(`${rpc}/`, { method: "POST", headers, cache: "no-store", signal: AbortSignal.timeout(15_000), body: JSON.stringify(payload) });
    return response.ok ? await storageResponseJson(response) : null;
  } catch {
    return null;
  }
}

const addresses = (body: unknown): string[] | null => {
  const value = body as { result?: unknown; response?: unknown } | null;
  return value?.result === 200 && Array.isArray(value.response)
    ? value.response.map((entry) => String((entry as { storageAddress?: unknown })?.storageAddress)).sort() : null;
};

export async function probeNodeContract(rpc: string, programName: string): Promise<NodeContractReport> {
  const base = rpc.replace(/\/$/, "");
  let storageNotFound = false;
  try {
    const response = await fetch(`${base}/storage-program/${UNOCCUPIED}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    const body = await storageResponseJson(response) as { success?: unknown; errorCode?: unknown } | null;
    storageNotFound = response.status === 404 && body?.success === false && body.errorCode === "NOT_FOUND";
  } catch { /* storageNotFound stays false */ }
  const options = { exactMatch: true, limit: 32, offset: 0 };
  const nodeCall = await post(base, { "content-type": "application/json" }, {
    method: "nodeCall",
    params: [{ type: "nodeCall", message: "searchStoragePrograms", sender: null, receiver: null, timestamp: null, data: { query: programName, options }, extra: "" }],
  });
  const gcr = await post(base, await gcrAuthHeaders(), { method: "gcr_routine", params: [{ method: "searchStoragePrograms", params: [programName, options] }] });
  const viaNodeCall = addresses(nodeCall);
  const viaGcr = addresses(gcr);
  const nodeCallSearch = viaNodeCall ? "supported"
    : (nodeCall as { result?: unknown; response?: unknown } | null)?.result === 200 && (nodeCall as { response?: unknown }).response === UNKNOWN_NODE_CALL
      ? "unknown-message" : "failed";
  const searchesAgree = viaNodeCall && viaGcr ? JSON.stringify(viaNodeCall) === JSON.stringify(viaGcr) : null;
  return {
    rpc: base, observedAt: new Date().toISOString(), storageNotFound, nodeCallSearch,
    gcrRoutineSearch: viaGcr ? "supported" : "failed", searchesAgree,
    // The Directory's resume lookup works when either search answers, and they must not disagree.
    ok: storageNotFound && (nodeCallSearch === "supported" || viaGcr !== null) && searchesAgree !== false,
  };
}
