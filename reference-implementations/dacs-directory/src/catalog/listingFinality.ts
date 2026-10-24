import { canonicalize, contentHash, sha256Hex } from "./canonical.js";
import { demosSignedTransactionProofHash } from "../sdkDemosWriteEvidence.js";

import { readAnchorRecord } from "./chain.js";
import { nodeBuildRejection, pinnedChainIdentity, reportedNodeBuild } from "./nodeDeployment.js";
import { storageResponseJson } from "./artifactLimits.js";

const RPC = (process.env.DEMOS_RPC ?? "https://demosnode.discus.sh/").replace(/\/$/, "");
const PAGE_SIZE = 100;
const MAX_TRANSACTIONS = 5_000;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const parsedRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "string") return record(value);
  try { return record(JSON.parse(value)); } catch { return null; }
};

async function nodeCall(message: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${RPC}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    signal: signal ?? AbortSignal.timeout(15_000),
    body: JSON.stringify({
      method: "nodeCall",
      params: [{ type: "nodeCall", message, sender: null, receiver: null, timestamp: null, data, extra: "" }],
    }),
  });
  if (!response.ok) throw new Error(`${message} transport failed`);
  const body = await storageResponseJson(response) as { result?: number; response?: unknown };
  if (body.result !== 200) throw new Error(`${message} returned ${String(body.result)}`);
  return body.response;
}

/**
 * Mirrors the pinned SDK's DemosAdapter.resolveChainIdentity: deployed nodes
 * (node2 0.9.8 among them) answer block zero with `result: 400` / `"error"`,
 * so a failed or hashless genesis read falls back to block one's predecessor.
 */
async function chainIdentity(signal?: AbortSignal): Promise<string> {
  const genesis = record(await nodeCall("getBlockByNumber", { blockNumber: 0 }, signal).catch(() => null));
  const genesisHash = typeof genesis?.hash === "string" ? genesis.hash.trim().toLowerCase() : "";
  const genesisNumber = genesis?.number ?? genesis?.id;
  if (/^[0-9a-f]{64}$/.test(genesisHash) && (genesisNumber === undefined || genesisNumber === 0)) return genesisHash;
  const first = record(await nodeCall("getBlockByNumber", { blockNumber: 1 }, signal));
  const firstContent = parsedRecord(first?.content);
  const previousHash = typeof firstContent?.previousHash === "string"
    ? firstContent.previousHash.trim().toLowerCase()
    : "";
  if (
    !first || first.status !== "confirmed" || first.number !== 1 ||
    typeof first.hash !== "string" || !/^[0-9a-f]{64}$/i.test(first.hash.trim()) || !/^[0-9a-f]{64}$/.test(previousHash)
  ) {
    throw new Error("Demos genesis block has no stable chain identity");
  }
  return previousHash;
}

/**
 * The configured node's deployment against this release's pin: its reported
 * build, then the chain it serves. The node reports both itself, so this
 * detects drift; it does not authenticate the node. Throws when the node
 * cannot be read.
 */
export async function pinnedNodeDeployment(): Promise<
  | { ok: true; build: string; chainIdentity: string }
  | { ok: false; reason: string }
> {
  const networkInfo = await nodeCall("getNetworkInfo", {});
  const buildRejection = nodeBuildRejection(networkInfo);
  if (buildRejection) return { ok: false, reason: buildRejection };
  const servedChain = await chainIdentity();
  if (servedChain !== pinnedChainIdentity()) {
    return { ok: false, reason: `Demos node serves chain ${servedChain}, not the pinned chain` };
  }
  return { ok: true, build: reportedNodeBuild(networkInfo) ?? "", chainIdentity: servedChain };
}

/** Catalog refreshes require the configured chain; self-reported build drift is diagnostic. */
export async function catalogNodeDeployment(signal?: AbortSignal): Promise<
  | { ok: true; build: string | null; chainIdentity: string; warning: string | null }
  | { ok: false; reason: string }
> {
  const servedChain = await chainIdentity(signal);
  if (servedChain !== pinnedChainIdentity()) {
    return { ok: false, reason: `Demos node serves chain ${servedChain}, not the pinned chain` };
  }
  const networkInfo = await nodeCall("getNetworkInfo", {}, signal).catch(() => null);
  return {
    ok: true,
    build: reportedNodeBuild(networkInfo),
    chainIdentity: servedChain,
    warning: nodeBuildRejection(networkInfo),
  };
}

/**
 * What the configured node reports, in the form DEMOS_NODE_BUILDS and
 * DEMOS_CHAIN_IDENTITY take, with the pin's verdict. For operators deciding
 * whether to re-pin (`npm run check:node-deployment`); reviewing the reported
 * chain and build is still the operator's call. Throws when the node cannot be read.
 */
export async function observeNodeDeployment(): Promise<{
  build: string | null;
  chainIdentity: string;
  pin: Awaited<ReturnType<typeof pinnedNodeDeployment>>;
}> {
  const networkInfo = await nodeCall("getNetworkInfo", {});
  const servedChain = await chainIdentity();
  return { build: reportedNodeBuild(networkInfo), chainIdentity: servedChain, pin: await pinnedNodeDeployment() };
}

