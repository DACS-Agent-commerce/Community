import assert from "node:assert/strict";
import test from "node:test";

import { observeNodeDeployment } from "../src/catalog/listingFinality.js";
import { PINNED_DEMOS_CHAIN_IDENTITY, PINNED_DEMOS_NODE_BUILDS } from "../src/catalog/nodeDeployment.js";

/** A node answering getNetworkInfo and block one's predecessor as given (block zero answers `error`, as node2 does). */
function nodeReporting(nodeVersion: Record<string, unknown>, chain: string): typeof fetch {
  return async (_input, init) => {
    const call = (JSON.parse(String(init?.body)) as { params?: Array<{ message?: string; data?: { blockNumber?: number } }> }).params?.[0];
    if (call?.message === "getNetworkInfo") return Response.json({ result: 200, response: { nodeVersion } });
    if (call?.data?.blockNumber === 0) return Response.json({ result: 400, response: "error" });
    return Response.json({
      result: 200,
      response: { id: 2, number: 1, status: "confirmed", hash: "12".repeat(32), content: { previousHash: chain, timestamp: 1 } },
    });
  };
}

async function observeWith(fetchImpl: typeof fetch) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await observeNodeDeployment();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("the deployment check reports a moved, modified node in the form the pin variables take", async () => {
  const commit = "11e7c82".padEnd(40, "a");
  const chain = "d59b54c2".padEnd(64, "b");
  const observed = await observeWith(nodeReporting({ commit, dirty: true, builtAt: "2026-10-20T11:09:32Z" }, chain));
  assert.equal(observed.chainIdentity, chain);
  assert.equal(observed.build, `${commit}+dirty@2026-10-20T11:09:32Z`);
  assert.equal(observed.pin.ok, false);
  // The reported values are what an operator reviews and sets; setting them is what makes the node pinned.
  const previous = { chain: process.env.DEMOS_CHAIN_IDENTITY, builds: process.env.DEMOS_NODE_BUILDS };
  process.env.DEMOS_CHAIN_IDENTITY = observed.chainIdentity;
  process.env.DEMOS_NODE_BUILDS = observed.build ?? "";
  try {
    const repinned = await observeWith(nodeReporting({ commit, dirty: true, builtAt: "2026-10-20T11:09:32Z" }, chain));
    assert.equal(repinned.pin.ok, true);
  } finally {
    if (previous.chain === undefined) delete process.env.DEMOS_CHAIN_IDENTITY; else process.env.DEMOS_CHAIN_IDENTITY = previous.chain;
    if (previous.builds === undefined) delete process.env.DEMOS_NODE_BUILDS; else process.env.DEMOS_NODE_BUILDS = previous.builds;
  }
});

test("the deployment check accepts the pinned chain and clean build", async () => {
  const observed = await observeWith(nodeReporting(
    { commit: PINNED_DEMOS_NODE_BUILDS[0], dirty: false, builtAt: "2026-10-14T16:45:24Z" },
    PINNED_DEMOS_CHAIN_IDENTITY,
  ));
  assert.equal(observed.pin.ok, true);
  assert.equal(observed.build, PINNED_DEMOS_NODE_BUILDS[0]);
});

test("the deployment check refuses the pinned build on another chain and an unreadable node", async () => {
  const other = await observeWith(nodeReporting(
    { commit: PINNED_DEMOS_NODE_BUILDS[0], dirty: false, builtAt: "2026-10-14T16:45:24Z" },
    "d59b54c2".padEnd(64, "b"),
  ));
  assert.equal(other.pin.ok, false);
  await assert.rejects(observeWith(async () => { throw new Error("offline"); }));
});
