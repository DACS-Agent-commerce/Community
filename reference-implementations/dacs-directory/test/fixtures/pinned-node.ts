import type { catalogNodeDeployment } from "../../src/catalog/listingFinality.js";
import { PINNED_DEMOS_CHAIN_IDENTITY, PINNED_DEMOS_NODE_BUILDS } from "../../src/catalog/nodeDeployment.js";

// reindexAll and index-now refuse a node that does not name its chain. Offline
// tests either inject one of these deployments or answer the node's chain
// reads with `pinnedNodeAnswer` inside their own fetch stub (subprocess scripts
// import it from "./test/fixtures/pinned-node.ts").

/** catalogNodeDeployment's report for a clean pinned build serving `chainIdentity`. */
export const nodeOnChain = (chainIdentity: string, warning: string | null = null): typeof catalogNodeDeployment =>
  async () => ({ ok: true, build: PINNED_DEMOS_NODE_BUILDS[0], chainIdentity, warning });

/** A node serving the pinned chain. */
export const onPinnedChain = nodeOnChain(PINNED_DEMOS_CHAIN_IDENTITY);

/** A node re-pointed mid-pass: its n-th deployment read reports `chains[n]`, then the last one. */
export const nodeServingInTurn = (...chains: string[]): typeof catalogNodeDeployment => {
  let reads = 0;
  return async () => nodeOnChain(chains[Math.min(reads++, chains.length - 1)])();
};

/**
 * The pinned node's answer to a chain-identity or build read (`getBlockByNumber`
 * 0 or 1, `getNetworkInfo`), or null for any other RPC body.
 */
export function pinnedNodeAnswer(body: unknown, chainIdentity = PINNED_DEMOS_CHAIN_IDENTITY): Response | null {
  if (typeof body !== "string") return null;
  let call: { message?: unknown; data?: { blockNumber?: unknown } } | undefined;
  try { call = (JSON.parse(body) as { params?: typeof call[] }).params?.[0]; } catch { return null; }
  if (call?.message === "getNetworkInfo") {
    return Response.json({ result: 200, response: { nodeVersion: { commit: PINNED_DEMOS_NODE_BUILDS[0], dirty: false } } });
  }
  if (call?.message !== "getBlockByNumber") return null;
  // Deployed nodes answer block zero with an error; block one's predecessor names the chain.
  return Response.json(call.data?.blockNumber === 1
    ? { result: 200, response: { id: 2, number: 1, status: "confirmed", hash: "12".repeat(32),
      content: { previousHash: chainIdentity, timestamp: 1 } } }
    : { result: 400, response: "error" });
}
