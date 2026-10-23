/**
 * Read-only probe of the node RPC contract the Directory depends on (README "Node deployment
 * contract"). It sends no transactions: one storage GET for an address no program occupies, and the
 * exact-name program search over both the deployed nodeCall and the pinned revision's gcr_routine,
 * followed by a fresh storage read of a known public program and the node's reported build.
 * Each search observation is dated runtime evidence, not a pin.
 */
import { storageResponseJson } from "./artifactLimits.js";
import { isUnknownNodeCall } from "./chain.js";
import { logicalToStorageProgramName } from "@kynesyslabs/dacs/canonical";
import { reportedNodeBuild } from "./nodeDeployment.js";

export interface NodeContractReport {
  rpc: string;
  observedAt: string;
  /** The node's own not-found answer for an unoccupied address: 404 with errorCode NOT_FOUND. */
  storageNotFound: boolean;
  nodeCallSearch: "supported" | "unknown-message" | "failed";
  gcrRoutineSearch: "supported" | "failed";
  /** Both searches answered and named the same programs for the exact name. */
  searchesAgree: boolean | null;
  /** Fresh storage replies expose metadata as an object or null. */
  storageMetadata: boolean;
  /** The caller's known SDK logical address agrees with metadata and the program name. */
  anchorMetadataMatches: boolean | null;
  /** Self-reported build observed during this probe; not a deployment attestation. */
  build: string | null;
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
  // A full page cannot establish completeness, matching resolveOwnedAnchorByName.
  if (value?.result !== 200 || !Array.isArray(value.response) || value.response.length >= 32) return null;
  const found: string[] = [];
  for (const entry of value.response) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.programName !== programName ||
        typeof entry.storageAddress !== "string" || !/^stor-[0-9a-f]{40}$/.test(entry.storageAddress)) return null;
    found.push(entry.storageAddress);
  }
  return found.sort();
};

export async function probeNodeContract(rpc: string, programName: string, expectedLogicalAddress?: string): Promise<NodeContractReport> {
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
  const gcr = await post(base, { "content-type": "application/json" }, { method: "gcr_routine", params: [{ method: "searchStoragePrograms", params: [programName, options] }] });
  const viaNodeCall = addresses(nodeCall, programName);
  const viaGcr = addresses(gcr, programName);
  const nodeCallSearch = viaNodeCall ? "supported"
    : nodeCall !== null && isUnknownNodeCall(nodeCall as { result?: unknown; response?: unknown })
      ? "unknown-message" : "failed";
  const searchesAgree = viaNodeCall && viaGcr ? JSON.stringify(viaNodeCall) === JSON.stringify(viaGcr) : null;
  // Agreement on an empty page proves no positive search/read contract. A known
  // program must still be publicly readable with the same exact name now.
  let knownProgramReadable = false;
  let storageMetadata = false;
  let anchorMetadataMatches: boolean | null = expectedLogicalAddress === undefined ? null : false;
  for (const candidate of new Set(viaGcr ?? [])) {
    try {
      const response = await fetch(`${base}/storage-program/${candidate}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      const body = await storageResponseJson(response) as { success?: unknown; programName?: unknown; owner?: unknown; data?: unknown; metadata?: unknown } | null;
      const readable = response.ok && body?.success === true && body.programName === programName &&
        typeof body.owner === "string" && /^(?:0x)?[0-9a-fA-F]{64}$/.test(body.owner) &&
        body.data !== null && typeof body.data === "object" && !Array.isArray(body.data);
      const metadata = body?.metadata;
      const metadataObject = metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
        ? metadata as Record<string, unknown> : null;
      const metadataValid = response.ok && body?.success === true && (metadata === null || metadataObject !== null);
      storageMetadata ||= metadataValid;
      let matches = expectedLogicalAddress === undefined;
      if (expectedLogicalAddress !== undefined) {
        const logicalAddress = metadataObject?.logicalAddress;
        // The pinned SDK DemosAdapter writes this name/address relation. This
        // observes the node's contract; it does not authenticate the writer.
        matches = typeof logicalAddress === "string" && logicalAddress.length > 0 &&
          logicalAddress.trim() === logicalAddress && logicalAddress === expectedLogicalAddress &&
          body?.programName === logicalToStorageProgramName(logicalAddress);
      }
      if (expectedLogicalAddress !== undefined) anchorMetadataMatches ||= matches;
      // A single fresh reply must satisfy every read/metadata/anchor check.
      if (readable && metadataValid && matches) {
        knownProgramReadable = true;
        break;
      }
    } catch { /* Continue through the bounded search set after an unreadable candidate. */ }
  }
  const network = await post(base, { "content-type": "application/json" }, {
    method: "nodeCall",
    params: [{ type: "nodeCall", message: "getNetworkInfo", sender: null, receiver: null, timestamp: null, data: {}, extra: "" }],
  }) as { result?: unknown; response?: unknown } | null;
  const build = network?.result === 200 ? reportedNodeBuild(network.response) : null;
  return {
    rpc: base, observedAt: new Date().toISOString(), storageNotFound, nodeCallSearch,
    gcrRoutineSearch: viaGcr ? "supported" : "failed", searchesAgree, storageMetadata, anchorMetadataMatches, build,
    // Resume lookup falls back only on the recognized unknown-message reply.
    ok: storageNotFound && knownProgramReadable && storageMetadata && viaGcr !== null &&
      (expectedLogicalAddress === undefined || (anchorMetadataMatches === true && build !== null)) &&
      ((nodeCallSearch === "supported" && searchesAgree === true) || nodeCallSearch === "unknown-message"),
  };
}
