// First: the store must open in a fresh directory, never the checkout's data/.
import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import test from "node:test";
import { scanStateCurrent, servedCatalogChain, servedChainUnchanged } from "../src/catalog/chainGate.js";
import { PINNED_DEMOS_CHAIN_IDENTITY } from "../src/catalog/nodeDeployment.js";
import { reindexAll, type ReindexOptions } from "../src/catalog/reindexCore.js";
import { SCAN_STATE_SCHEMA_VERSION } from "../src/catalog/scanState.js";
import { loadScanState, loadCatalogChain, saveRegistrations, saveScanState } from "../src/catalog/store.js";
import { nodeOnChain, onPinnedChain, pinnedNodeAnswer } from "./fixtures/pinned-node.js";

const OTHER_CHAIN = "aa".repeat(32);
const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

/** Answer node RPC bodies with `answer`, falling back to an empty page. */
const node = (answer: (body: unknown) => Response | null) => {
  globalThis.fetch = async (_input, init) => answer(init?.body) ?? Response.json({ result: 200, response: [] });
};

test("the gate passes the pinned chain with its build warning", async () => {
  assert.deepEqual(await servedCatalogChain(onPinnedChain), { ok: true, chainIdentity: PINNED_DEMOS_CHAIN_IDENTITY, warning: null });
  assert.deepEqual(await servedCatalogChain(nodeOnChain(PINNED_DEMOS_CHAIN_IDENTITY, "drift")),
    { ok: true, chainIdentity: PINNED_DEMOS_CHAIN_IDENTITY, warning: "drift" });
  node(pinnedNodeAnswer);
  assert.deepEqual(await servedCatalogChain(), { ok: true, chainIdentity: PINNED_DEMOS_CHAIN_IDENTITY, warning: null });
});

test("the configured node's timeout, transport failure, malformed genesis and other chain give different causes", async () => {
  const malformedBlockOne = (body: unknown) => {
    const answer = pinnedNodeAnswer(body);
    return answer && String(body).includes('"blockNumber":1')
      ? Response.json({ result: 200, response: { number: 1, status: "pending", hash: "12".repeat(32), content: {} } }) : answer;
  };
  const cases: Array<[string, typeof globalThis.fetch, 503 | 409, string]> = [
    ["timeout", async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }, 503, "NODE_TIMEOUT"],
    ["refused connection", async () => { throw new TypeError("fetch failed"); }, 503, "NODE_TRANSPORT"],
    ["HTTP 502", async () => new Response("bad gateway", { status: 502 }), 503, "NODE_TRANSPORT"],
    ["malformed block one", async (_input, init) => malformedBlockOne(init?.body) ?? Response.json({ result: 200, response: [] }), 503, "GENESIS_UNREADABLE"],
    ["error answer", async () => Response.json({ result: 500, response: "x".repeat(10_000) }), 503, "GENESIS_UNREADABLE"],
    ["another chain", async (_input, init) => pinnedNodeAnswer(init?.body, OTHER_CHAIN) ?? Response.json({ result: 200, response: [] }), 409, "WRONG_CHAIN"],
  ];
  for (const [name, fetch, status, code] of cases) {
    globalThis.fetch = fetch;
    const gate = await servedCatalogChain();
    assert.equal(gate.ok, false, name);
    if (gate.ok) continue;
    assert.equal(gate.status, status, name);
    assert.ok(gate.cause.startsWith(`${code}: `), `${name}: ${gate.cause}`);
    assert.ok(gate.cause.length <= code.length + 2 + 200, `${name}: the node's text is bounded`);
  }
});

test("node-supplied text in a cause is bounded and printable", async () => {
  const gate = await servedCatalogChain(async () => ({ ok: false, reason: `line\nbreak\u0000${"z".repeat(500)}` }));
  assert.equal(gate.ok, false);
  if (gate.ok) return;
  assert.match(gate.cause, /^WRONG_CHAIN: line\?break\?z+$/);
  assert.equal(gate.cause.length, "WRONG_CHAIN: ".length + 200);
});

test("the second read refuses a node that now serves another chain or cannot be read", async () => {
  assert.deepEqual(await servedChainUnchanged(PINNED_DEMOS_CHAIN_IDENTITY, onPinnedChain),
    { ok: true, chainIdentity: PINNED_DEMOS_CHAIN_IDENTITY, warning: null });
  assert.deepEqual(await servedChainUnchanged(OTHER_CHAIN, onPinnedChain),
    { ok: false, status: 409, cause: `WRONG_CHAIN: the node now serves chain ${PINNED_DEMOS_CHAIN_IDENTITY}` });
  const unreadable = await servedChainUnchanged(PINNED_DEMOS_CHAIN_IDENTITY, async () => { throw new TypeError("fetch failed"); });
  assert.deepEqual(unreadable, { ok: false, status: 503, cause: "NODE_TRANSPORT: fetch failed" });
});

test("readiness requires matching durable provenance, ready schema and scanner schema", () => {
  const state = { lastSeenTxId: 1, listings: {}, deals: {}, schemaVersion: SCAN_STATE_SCHEMA_VERSION };
  const control = { evidenceChain: OTHER_CHAIN, readySchema: SCAN_STATE_SCHEMA_VERSION };
  assert.equal(scanStateCurrent(state, OTHER_CHAIN, control), true);
  assert.equal(scanStateCurrent(state, PINNED_DEMOS_CHAIN_IDENTITY, control), false);
  assert.equal(scanStateCurrent(state, OTHER_CHAIN, null), false);
  assert.equal(scanStateCurrent(state, OTHER_CHAIN, { ...control, readySchema: null }), false);
  assert.equal(scanStateCurrent({ ...state, schemaVersion: 0 }, OTHER_CHAIN, control), false);
});

test("a reindex with no injected deployment reads the pinned chain from the node and records it", async () => {
  saveRegistrations([]);
  saveScanState({ lastSeenTxId: 0, listings: {}, deals: {} });
  node(pinnedNodeAnswer);
  await reindexAll({ log: () => {}, crawlWellKnown: async () => ({ agents: [], errors: [] }) });
  assert.deepEqual(loadCatalogChain(), { evidenceChain: PINNED_DEMOS_CHAIN_IDENTITY, readySchema: SCAN_STATE_SCHEMA_VERSION });
  assert.equal(loadScanState().chainIdentity, undefined, "canonical scanner saves retire identity fields");
  assert.equal(loadScanState().schemaVersion, SCAN_STATE_SCHEMA_VERSION);
});

test("a deployment stub must name the chain it serves", () => {
  // @ts-expect-error catalogNodeDeployment always reports chainIdentity; a stub without it does not type-check.
  const stale: ReindexOptions["nodeDeployment"] = async () => ({ ok: true as const, build: null, warning: null });
  assert.equal(typeof stale, "function");
});
