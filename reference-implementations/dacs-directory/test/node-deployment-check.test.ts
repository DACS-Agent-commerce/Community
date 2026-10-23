import "./fixtures/isolated-data-dir.js";
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

test("node build commits must match the whole string even with an explicit pin", async () => {
  const { nodeBuildRejection, reportedNodeBuild } = await import("../src/catalog/nodeDeployment.js");
  const commit = PINNED_DEMOS_NODE_BUILDS[0];
  for (const malformed of [`x${commit}`, `${commit}x`]) {
    const info = { nodeVersion: { commit: malformed, dirty: false } };
    assert.equal(reportedNodeBuild(info), null);
    assert.equal(nodeBuildRejection(info, [malformed]), "Demos node reports no build identity");
  }
  assert.equal(reportedNodeBuild({ nodeVersion: { commit, dirty: true } }), `${commit}+dirty@`);
});


test("catalog refreshes admit build drift on the pinned chain and return a warning", async () => {
  const { catalogNodeDeployment } = await import("../src/catalog/listingFinality.js");
  const originalFetch = globalThis.fetch;
  try {
    for (const version of [
      { commit: "f".repeat(40), dirty: false },
      { commit: "f".repeat(40), dirty: true, builtAt: "2026-10-20T11:09:32Z" },
      {},
    ]) {
      globalThis.fetch = nodeReporting(version, PINNED_DEMOS_CHAIN_IDENTITY);
      const result = await catalogNodeDeployment();
      assert.equal(result.ok, true);
      assert.ok(result.ok && result.warning);
    }
    globalThis.fetch = nodeReporting({}, "a".repeat(64));
    assert.equal((await catalogNodeDeployment()).ok, false);
  } finally { globalThis.fetch = originalFetch; }
});

test("a status deadline also cancels the fallback chain read", async () => {
  const { catalogNodeDeployment } = await import("../src/catalog/listingFinality.js");
  const originalFetch = globalThis.fetch;
  const budget = new AbortController();
  const calls: number[] = [];
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.signal, budget.signal);
    const call = JSON.parse(String(init?.body)).params[0];
    calls.push(call.data.blockNumber);
    budget.signal.throwIfAborted();
    return new Promise((_resolve, reject) => {
      budget.signal.addEventListener("abort", () => reject(budget.signal.reason), { once: true });
    });
  };
  try {
    const pending = catalogNodeDeployment(budget.signal);
    budget.abort(new Error("status deadline reached"));
    await assert.rejects(pending, /status deadline reached/);
    assert.deepEqual(calls, [0, 1]);
  } finally { globalThis.fetch = originalFetch; }
});

test("catalog deployment reports the pinned clean build without a warning", async () => {
  const { catalogNodeDeployment } = await import("../src/catalog/listingFinality.js");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = nodeReporting({ commit: PINNED_DEMOS_NODE_BUILDS[0], dirty: false }, PINNED_DEMOS_CHAIN_IDENTITY);
  try {
    const result = await catalogNodeDeployment();
    assert.equal(result.ok, true);
    assert.ok(result.ok);
    assert.equal(result.build, PINNED_DEMOS_NODE_BUILDS[0]);
    assert.equal(result.warning, null);
  } finally { globalThis.fetch = originalFetch; }
});


test("deployment observations reject oversized node bodies and malformed chain hashes", async () => {
  const report = nodeReporting({ commit: PINNED_DEMOS_NODE_BUILDS[0], dirty: false }, PINNED_DEMOS_CHAIN_IDENTITY);
  await assert.rejects(observeWith(async () => new Response("x".repeat(1_048_577))));
  for (const chain of ["untrusted-node-message", "a".repeat(63), "a".repeat(65)]) {
    await assert.rejects(observeWith(nodeReporting({ commit: PINNED_DEMOS_NODE_BUILDS[0], dirty: false }, chain)), /no stable chain identity/);
  }
  assert.equal((await observeWith(report)).pin.ok, true);
});

test("the deployment CLI observes the node without opening catalog storage", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, rmSync, writeFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const scratch = mkdtempSync(join(tmpdir(), "deployment-readonly-"));
  try {
    const preload = join(scratch, "node-report.mjs");
    writeFileSync(preload, `globalThis.fetch = ${nodeReporting.toString()}(${JSON.stringify({ commit: PINNED_DEMOS_NODE_BUILDS[0], dirty: false })}, ${JSON.stringify(PINNED_DEMOS_CHAIN_IDENTITY)});`);
    const data = join(scratch, "catalog");
    const run = spawnSync(process.execPath, [...process.execArgv, "--import", pathToFileURL(preload).href,
      fileURLToPath(new URL("../scripts/check-node-deployment.ts", import.meta.url))], {
      env: { ...process.env, DACS_DIRECTORY_DATA: data }, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).pinned, true);
    assert.equal(existsSync(data), false, "the read-only check must not create or migrate the catalog");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
