import { storageResponseJson } from "./artifactLimits.js";
import { catalogNodeDeployment } from "./listingFinality.js";
import { pinnedChainIdentity, pinnedNodeBuilds } from "./nodeDeployment.js";

const RPC = (process.env.DEMOS_RPC ?? "https://demosnode.discus.sh/").replace(/\/$/, "");
export const STATUS_NODE_OBSERVATION_TTL_MS = 30_000;

async function observeNode() {
  // Status reads have their own budgets; indexing preflights stay independent.
  const signal = AbortSignal.timeout(3_000);
  const nodeDeployment = await catalogNodeDeployment(signal).catch(() => ({
    ok: false as const,
    unavailable: true,
    reason: signal.aborted ? "Demos node chain check timed out" : "could not read the Demos node's chain",
  }));
  let chainLatestTx: number | null = null;
  if (nodeDeployment.ok) {
    try {
      const res = await fetch(RPC + "/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(3_000),
        cache: "no-store",
        body: JSON.stringify({ method: "nodeCall", params: [{
          type: "nodeCall", message: "getTransactions", sender: null, receiver: null, timestamp: null,
          data: { start: "latest", limit: 1 }, extra: "",
        }] }),
      });
      if (!res.ok) throw new Error("chain tip transport failed");
      const json = (await storageResponseJson(res)) as { result?: number; response?: Array<{ id?: number }> };
      const rows = json?.result === 200 && Array.isArray(json.response) && json.response.length <= 1
        ? json.response : [];
      const id = rows[0]?.id;
      if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) chainLatestTx = id;
    } catch {
      /* node unreachable — report lag as unknown */
    }
  }
  return { nodeDeployment, chainLatestTx };
}

type NodeObservation = Awaited<ReturnType<typeof observeNode>>;

/** One shared in-flight probe and a short cache, including unavailable observations. */
export function createStatusNodeObservationCache(
  observe: () => Promise<NodeObservation> = observeNode,
  now: () => number = () => Date.now(),
  configuration: () => string = () => JSON.stringify([RPC, pinnedChainIdentity(), pinnedNodeBuilds()]),
) {
  let cached: { value: NodeObservation; key: string; observedAt: number } | undefined;
  let pending: { promise: Promise<NodeObservation>; key: string } | undefined;
  return {
    invalidate() { cached = undefined; pending = undefined; },
    async read(): Promise<NodeObservation> {
      const key = configuration();
      const at = now();
      if (cached?.key === key && at >= cached.observedAt && at - cached.observedAt < STATUS_NODE_OBSERVATION_TTL_MS) {
        return cached.value;
      }
      if (pending?.key === key) return pending.promise;
      const current = { key, promise: Promise.resolve().then(observe) };
      pending = current;
      try {
        const value = await current.promise;
        if (pending === current) cached = { key, value, observedAt: now() };
        return value;
      } finally {
        if (pending === current) pending = undefined;
      }
    },
  };
}

export const statusNodeObservationCache = createStatusNodeObservationCache();
