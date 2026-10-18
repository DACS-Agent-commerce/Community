/**
 * Read-only probe of the node RPC contract the Directory depends on (README "Node deployment
 * contract"). It sends no transactions: one storage GET for an address no program occupies, and the
 * exact-name program search over both the deployed nodeCall and the pinned revision's gcr_routine.
 * Each search observation is dated runtime evidence, not a pin.
 */
import { storageResponseJson } from "./artifactLimits.js";
import { isUnknownNodeCall } from "./chain.js";
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

const addresses = (body: unknown, programName: string): string[] | null => {
  const value = body as { result?: unknown; response?: unknown } | null;
  if (value?.result !== 200 || !Array.isArray(value.response) || value.response.length > 32) return null;
  const found: string[] = [];
  for (const entry of value.response) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.programName !== programName ||
        typeof entry.storageAddress !== "string" || !/^stor-[0-9a-f]{40}$/.test(entry.storageAddress)) return null;
    found.push(entry.storageAddress);
  }
  return found.sort();
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
  const viaNodeCall = addresses(nodeCall, programName);
  const viaGcr = addresses(gcr, programName);
  const nodeCallSearch = viaNodeCall ? "supported"
    : nodeCall !== null && isUnknownNodeCall(nodeCall as { result?: unknown; response?: unknown })
      ? "unknown-message" : "failed";
  const searchesAgree = viaNodeCall && viaGcr ? JSON.stringify(viaNodeCall) === JSON.stringify(viaGcr) : null;
  return {
    rpc: base, observedAt: new Date().toISOString(), storageNotFound, nodeCallSearch,
    gcrRoutineSearch: viaGcr ? "supported" : "failed", searchesAgree,
    // Resume lookup falls back only on the recognized unknown-message reply.
    ok: storageNotFound && (nodeCallSearch === "supported" || (nodeCallSearch === "unknown-message" && viaGcr !== null)) && searchesAgree !== false,
  };
}
