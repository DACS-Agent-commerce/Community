import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-chain-reset-"));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_input, init) => {
  const message = JSON.parse(String(init?.body)).params?.[0]?.message;
  assert.equal(message, "getTransactions");
  return Response.json({ result: 200, response: [{ id: 5 }, { id: 4 }, { id: 3 }, { id: 2 }, { id: 1 }] });
};

process.env.DACS_DIRECTORY_DATA = dataDirectory;
process.env.DEMOS_RPC = "https://rpc.example";
process.env.DACS_SCAN_RESET_THRESHOLD = "1000";

const store = await import("../src/catalog/store.js");
const { reindexAll } = await import("../src/catalog/reindexCore.js");

test.after(() => {
  globalThis.fetch = originalFetch;
  rmSync(dataDirectory, { recursive: true, force: true });
});

test("reindex clears replaced-chain discoveries and rescans from genesis in one run", async () => {
  store.saveScanState({
    schemaVersion: 4,
    lastSeenTxId: 147_262,
    // Old releases retained the high cursor but overwrote this observation
    // with the replacement chain's low tip on every zero-work scan.
    lastChainTip: 5,
    listings: { [`stor-${"a".repeat(40)}`]: `0x${"b".repeat(64)}` },
    deals: {},
  });
  store.recordArtifactFailure(`stor-${"c".repeat(40)}`, "listing", "STORAGE_UNREADABLE", "old chain", 1);
  const logs: string[] = [];

  const result = await reindexAll({ log: (line) => logs.push(line), nodeDeployment: async () => ({ ok: true as const }) });

  assert.equal(result.cursor, 3, "finality depth leaves the newest two transactions for replay");
  assert.equal(store.loadScanState().schemaVersion, 10);
  assert.deepEqual(Object.keys(store.loadScanState().listings), []);
  assert.equal(store.indexerDiagnostics().deadLetters, 0);
  assert.match(logs[0] ?? "", /chain replacement detected/);
});


test("a re-pin clears a cursor even when the new chain has a higher tip", async () => {
  const { SCAN_STATE_SCHEMA_VERSION } = await import("../src/catalog/scanState.js");
  const calls: number[] = [];
  globalThis.fetch = async (_input, init) => {
    const { message, data } = JSON.parse(String(init?.body)).params[0];
    assert.equal(message, "getTransactions");
    calls.push(data.start);
    return Response.json({ result: 200, response: [{ id: 200 }, { id: 199 }, { id: 198 }, { id: 2 }, { id: 1 }] });
  };
  const oldChain = "a".repeat(64), newChain = "b".repeat(64);
  for (const chainIdentity of [oldChain, undefined]) {
    calls.length = 0;
    store.saveScanState({ schemaVersion: SCAN_STATE_SCHEMA_VERSION, chainIdentity, lastSeenTxId: 100, lastChainTip: 100,
      listings: { [`stor-${"a".repeat(40)}`]: `0x${"b".repeat(64)}` }, deals: {} });
    await reindexAll({ log: () => {}, nodeDeployment: async () => ({ ok: true, chainIdentity: newChain }) });
    assert.equal(store.loadScanState().chainIdentity, newChain);
    assert.deepEqual(Object.keys(store.loadScanState().listings), []);
    assert.equal(store.loadScanState().lastSeenTxId, 198);
    assert.ok(calls.length > 1);
  }
  globalThis.fetch = originalFetch;
});


test("a refused deployment leaves the cursor, chain and catalog unchanged", async () => {
  const chainIdentity = "a".repeat(64);
  store.saveScanState({ chainIdentity, schemaVersion: 10, lastSeenTxId: 100, listings: {}, deals: {} });
  const prior = { catalogVersion: "1" as const, generatedAt: 123, sellers: [] };
  store.saveCatalog(prior);
  await assert.rejects(reindexAll({ log: () => {}, nodeDeployment: async () => ({ ok: false, reason: "unpinned build" }) }), /unpinned build/);
  assert.equal(store.loadScanState().lastSeenTxId, 100);
  assert.equal(store.loadScanState().chainIdentity, chainIdentity);
  assert.deepEqual(store.loadCatalog(), prior);
});

test("an interrupted re-pin replay remains due and same-chain incremental scans retain discoveries", async () => {
  const chainIdentity = "c".repeat(64);
  const deployment = async () => ({ ok: true as const, chainIdentity });
  store.saveScanState({ chainIdentity: "b".repeat(64), schemaVersion: 10, lastSeenTxId: 100, listings: {}, deals: {} });
  globalThis.fetch = async () => { throw new Error("node unavailable"); };
  await assert.rejects(reindexAll({ log: () => {}, nodeDeployment: deployment }), /chain scan failed/);
  assert.equal(store.loadScanState().chainIdentity, chainIdentity);
  assert.equal(store.loadScanState().schemaVersion, 0);
  assert.equal(store.loadScanState().lastSeenTxId, 0);
  globalThis.fetch = async (_input, init) => {
    if (init?.body) return Response.json({ result: 200, response: [{ id: 5 }, { id: 4 }, { id: 3 }, { id: 2 }, { id: 1 }] });
    return new Response(null, { status: 503 });
  };
  await reindexAll({ log: () => {}, nodeDeployment: deployment });
  assert.equal(store.loadScanState().schemaVersion, 10);
  const known = `stor-${"a".repeat(40)}`;
  store.saveScanState({ ...store.loadScanState(), listings: { [known]: `0x${"b".repeat(64)}` } });
  await reindexAll({ log: () => {}, nodeDeployment: deployment });
  assert.ok(Object.hasOwn(store.loadScanState().listings, known), "same chain retains accumulated discoveries");
});

test("same-chain tip regression clears discoveries only beyond the configured threshold", async () => {
  const chainIdentity = "d".repeat(64);
  const anchor = `stor-${"a".repeat(40)}`;
  for (const [previousTip, reset] of [[2000, true], [500, false]] as const) {
    globalThis.fetch = async (_input, init) => init?.method === "POST"
      ? Response.json({ result: 200, response: [{ id: 5 }, { id: 4 }, { id: 3 }, { id: 2 }, { id: 1 }] })
      : new Response(null, { status: 503 });
    // An earlier zero-work pass retained the cursor but stored the replacement's low tip.
    store.saveScanState({ schemaVersion: 10, chainIdentity, lastSeenTxId: previousTip, lastChainTip: 5,
      listings: { [anchor]: `0x${"b".repeat(64)}` }, deals: {} });
    const logs: string[] = [];
    await reindexAll({ log: line => logs.push(line), nodeDeployment: async () => ({ ok: true, chainIdentity }) });
    assert.equal(Object.hasOwn(store.loadScanState().listings, anchor), !reset);
    assert.equal(logs.some(line => line.includes("chain replacement detected")), reset);
    assert.equal(store.loadScanState().chainIdentity, chainIdentity);
  }
});

test("successful refreshes log a deployment build warning", async () => {
  const chainIdentity = "d".repeat(64);
  store.saveScanState({ schemaVersion: 10, chainIdentity, lastSeenTxId: 3, lastChainTip: 5, listings: {}, deals: {} });
  globalThis.fetch = async () => Response.json({ result: 200, response: [{ id: 5 }, { id: 4 }, { id: 3 }, { id: 2 }, { id: 1 }] });
  const logs: string[] = [];
  const warning = "Demos node build differs from the reviewed build";
  const result = await reindexAll({ log: line => logs.push(line), nodeDeployment: async () => ({ ok: true, chainIdentity, warning }) });
  assert.equal(result.cursor, 3);
  assert.ok(logs.some(line => line.includes(warning)));
});
