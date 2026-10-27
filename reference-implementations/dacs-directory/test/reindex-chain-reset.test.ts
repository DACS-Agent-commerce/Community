import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { catalogNodeDeployment } from "../src/catalog/listingFinality.js";
import type { SellerRecord } from "../src/catalog/types.js";
import { nodeOnChain, nodeServingInTurn, onPinnedChain } from "./fixtures/pinned-node.js";

const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-chain-reset-"));
const originalFetch = globalThis.fetch;
/** Five transactions, newest first; only getTransactions is expected once the deployment is injected. */
const serveFiveTransactions = () => {
  globalThis.fetch = async (_input, init) => {
    const message = JSON.parse(String(init?.body)).params?.[0]?.message;
    assert.equal(message, "getTransactions");
    return Response.json({ result: 200, response: [{ id: 5 }, { id: 4 }, { id: 3 }, { id: 2 }, { id: 1 }] });
  };
};
serveFiveTransactions();

process.env.DACS_DIRECTORY_DATA = dataDirectory;
process.env.DEMOS_RPC = "https://rpc.example";
process.env.DACS_SCAN_RESET_THRESHOLD = "1000";

const store = await import("../src/catalog/store.js");
const { reindexAll } = await import("../src/catalog/reindexCore.js");
const { SCAN_STATE_SCHEMA_VERSION } = await import("../src/catalog/scanState.js");

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

  const result = await reindexAll({ log: (line) => logs.push(line), nodeDeployment: onPinnedChain });

  assert.equal(result.cursor, 3, "finality depth leaves the newest two transactions for replay");
  assert.equal(store.loadScanState().schemaVersion, 10);
  assert.deepEqual(Object.keys(store.loadScanState().listings), []);
  assert.equal(store.indexerDiagnostics().deadLetters, 0);
  assert.match(logs[0] ?? "", /chain replacement detected/);
});

const OLD_CHAIN = "a".repeat(64);
const NEW_CHAIN = "b".repeat(64);
const oldAnchor = `stor-${"a".repeat(40)}`;
const oldMarker = `stor-${"2".repeat(40)}`;
const oldContentHash = "e".repeat(64);
const replacedChainSeller = (): SellerRecord => {
  const seller = `did:demos:agent:${"a".repeat(64)}`;
  return {
    primaryClaim: seller, displayName: "old-chain-seller", cci: [], deals: [], registeredAt: 1, lastIndexedAt: 1,
    reputation: { completed: 0, totalAgreements: 0, completionRate: null },
    listings: [{
      listingId: "old", version: 1, contentHash: oldContentHash, anchor: { kind: "storage-program", locator: `stor-${"1".repeat(40)}` },
      seller: { primaryClaim: seller, displayName: "old-chain-seller" },
      offering: { title: "old", category: "services.test", tags: [] }, pricing: {}, status: "revoked", catalogObservedAt: 1,
      revocation: { sellerPrimaryClaim: seller, listingId: "old", listingVersion: 1, listingContentHash: oldContentHash,
        logicalAddress: `dacs1-revoked:${encodeURIComponent(seller)}:old:v1`,
        markerAnchor: { kind: "storage-program", locator: oldMarker }, markerContentHash: "d".repeat(64) },
    }],
  };
};
/** A complete pass's state on the old chain: a discovered listing, a program binding and a verified marker. */
const oldChainState = () => ({
  chainIdentity: OLD_CHAIN, schemaVersion: SCAN_STATE_SCHEMA_VERSION, lastSeenTxId: 100, lastChainTip: 100,
  listings: { [oldAnchor]: `0x${"b".repeat(64)}` }, deals: {},
  programs: { [`0x${"b".repeat(64)}\ndacs1:listing:old`]: oldAnchor },
  revocations: { [oldContentHash]: [oldMarker] }, verifiedRevocations: { [oldContentHash]: [oldMarker] },
});
const emptyCatalog = { catalogVersion: "1" as const, generatedAt: 1, sellers: [] };
const lastRunRow = () => {
  const db = new Database(join(dataDirectory, "directory.sqlite"), { readonly: true });
  try {
    return db.prepare("SELECT status, error, txs_scanned FROM scan_runs ORDER BY id DESC LIMIT 1").get() as
      { status: string; error: string | null; txs_scanned: number };
  } finally { db.close(); }
};
/** Nothing the replaced chain produced is left in the scan state, the catalog or the artifact tables. */
const assertNothingFromOldChain = () => {
  const state = store.loadScanState();
  assert.deepEqual(Object.keys(state.listings), []);
  assert.deepEqual(Object.keys(state.programs), []);
  assert.deepEqual(Object.keys(state.revocations ?? {}), []);
  assert.equal(Object.hasOwn(state.verifiedRevocations ?? {}, oldContentHash), false);
  assert.deepEqual(store.loadCatalog().sellers, []);
  assert.deepEqual(store.indexerDiagnostics().artifacts, {});
};

test("a node that is refused or cannot be read fails the pass and changes nothing", async () => {
  store.saveRegistrations([]);
  store.saveScanState(oldChainState());
  store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [replacedChainSeller()] });
  store.recordArtifactFailure(`stor-${"c".repeat(40)}`, "listing", "STORAGE_UNREADABLE", "kept", 5);
  const before = { state: store.loadScanState(), catalog: store.loadCatalog(), artifacts: store.indexerDiagnostics().artifacts };
  let nodeReads = 0;
  globalThis.fetch = async () => { nodeReads++; throw new Error("the refused pass read the node"); };
  const refusals: Array<[typeof catalogNodeDeployment, RegExp]> = [
    [async () => ({ ok: false, reason: `Demos node serves chain ${NEW_CHAIN}, not the pinned chain` }), /catalog not updated: WRONG_CHAIN: /],
    [async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }, /catalog not updated: NODE_TIMEOUT: /],
    [async () => { throw new Error("Demos genesis block has no stable chain identity"); }, /catalog not updated: GENESIS_UNREADABLE: /],
  ];
  try {
    for (const [nodeDeployment, cause] of refusals) {
      await assert.rejects(reindexAll({ log: () => {}, nodeDeployment }), cause);
      assert.deepEqual(store.loadScanState(), before.state);
      assert.deepEqual(store.loadCatalog(), before.catalog);
      assert.deepEqual(store.indexerDiagnostics().artifacts, before.artifacts);
      const run = lastRunRow();
      assert.equal(run.status, "failed", "the public status shows the refusal");
      assert.match(String(run.error), cause);
      assert.equal(run.txs_scanned, 0);
    }
    assert.equal(nodeReads, 0);
  } finally {
    serveFiveTransactions();
  }
});

test("a re-pin empties the catalog first and carries nothing from the replaced chain into the rebuild", async () => {
  store.saveRegistrations([]);
  store.saveScanState(oldChainState());
  store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [replacedChainSeller()] });
  store.recordArtifactFailure(`stor-${"c".repeat(40)}`, "listing", "STORAGE_UNREADABLE", "old chain", 1);
  // The rebuild's first scan fails: the old catalog is already gone and the reset stays due.
  globalThis.fetch = async () => { throw new Error("node unavailable"); };
  await assert.rejects(reindexAll({ log: () => {}, nodeDeployment: nodeOnChain(NEW_CHAIN) }), /chain scan failed/);
  assertNothingFromOldChain();
  assert.equal(store.loadScanState().chainIdentity, undefined);
  assert.equal(store.loadScanState().schemaVersion, 0);

  serveFiveTransactions();
  const logs: string[] = [];
  await reindexAll({ log: (line) => logs.push(line), nodeDeployment: nodeOnChain(NEW_CHAIN) });
  assertNothingFromOldChain();
  assert.equal(store.loadScanState().chainIdentity, NEW_CHAIN);
  assert.equal(store.loadScanState().schemaVersion, SCAN_STATE_SCHEMA_VERSION);
  assert.equal(logs.some((line) => line.includes("chain replacement detected")), false, "the reset ran once");
});

test("a re-pin interrupted after each reset step converges on the next pass", async () => {
  serveFiveTransactions();
  const resetState = { schemaVersion: 0, lastSeenTxId: 0, listings: {}, deals: {} };
  // What a crash leaves: after the empty catalog is saved (a), after the artifacts are cleared (b),
  // after the reset state is saved (c).
  for (const step of ["a", "b", "c"] as const) {
    store.saveRegistrations([]);
    store.saveCatalog(emptyCatalog);
    store.recordArtifactFailure(`stor-${"c".repeat(40)}`, "listing", "STORAGE_UNREADABLE", "old chain", 1);
    if (step !== "a") store.clearChainDerivedArtifacts();
    store.saveScanState(step === "c" ? resetState : oldChainState());
    await reindexAll({ log: () => {}, nodeDeployment: nodeOnChain(NEW_CHAIN) });
    assertNothingFromOldChain();
    assert.equal(store.loadScanState().chainIdentity, NEW_CHAIN, step);
    assert.equal(store.loadScanState().schemaVersion, SCAN_STATE_SCHEMA_VERSION, step);
  }
});

/** Serve twelve transactions, at most three per call, honouring the requested start and limit. */
function serveTwelveTransactions(starts: Array<number | string>): void {
  globalThis.fetch = async (_input, init) => {
    const { start, limit } = JSON.parse(String(init?.body)).params[0].data;
    starts.push(start);
    const first = start === "latest" ? 12 : start;
    const ids = Array.from({ length: Math.min(limit, 3, first) }, (_, i) => first - i);
    return Response.json({ result: 200, response: ids.map((id) => ({ id })) });
  };
}

test("a replay longer than DACS_SCAN_MAX_TXS fails closed and records no chain until a complete pass", async () => {
  const CHAIN = "e".repeat(64);
  serveTwelveTransactions([]);
  process.env.DACS_SCAN_MAX_TXS = "4";
  try {
    // A legacy cache with no recorded chain keeps its state and catalog.
    store.saveRegistrations([]);
    store.saveScanState({ schemaVersion: SCAN_STATE_SCHEMA_VERSION, lastSeenTxId: 8, listings: { [oldAnchor]: `0x${"b".repeat(64)}` }, deals: {} });
    store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [replacedChainSeller()] });
    const legacy = { state: store.loadScanState(), catalog: store.loadCatalog() };
    await assert.rejects(reindexAll({ log: () => {}, nodeDeployment: nodeOnChain(CHAIN) }), /DACS_SCAN_MAX_TXS=4/);
    assert.deepEqual(store.loadScanState(), legacy.state);
    assert.deepEqual(store.loadCatalog(), legacy.catalog);

    // A re-pin stays reset: no chain, an old schema, an empty catalog.
    store.saveScanState(oldChainState());
    await assert.rejects(reindexAll({ log: () => {}, nodeDeployment: nodeOnChain(CHAIN) }), /DACS_SCAN_MAX_TXS=4/);
    assert.equal(store.loadScanState().chainIdentity, undefined);
    assert.equal(store.loadScanState().schemaVersion, 0);
    assert.deepEqual(store.loadCatalog().sellers, []);
  } finally {
    delete process.env.DACS_SCAN_MAX_TXS;
  }
  // With a cap that covers the history, one pass records the chain and the schema together.
  await reindexAll({ log: () => {}, nodeDeployment: nodeOnChain(CHAIN) });
  assert.equal(store.loadScanState().chainIdentity, CHAIN);
  assert.equal(store.loadScanState().schemaVersion, SCAN_STATE_SCHEMA_VERSION);
  assert.equal(store.loadScanState().lastSeenTxId, 10);
  serveFiveTransactions();
});

test("a state with no recorded chain replays once and keeps its discoveries; the next pass is incremental", async () => {
  const fromTx = () => {
    const db = new Database(join(dataDirectory, "directory.sqlite"), { readonly: true });
    try { return (db.prepare("SELECT from_tx FROM scan_runs ORDER BY id DESC LIMIT 1").get() as { from_tx: number }).from_tx; }
    finally { db.close(); }
  };
  store.saveRegistrations([]);
  store.saveScanState({ schemaVersion: SCAN_STATE_SCHEMA_VERSION, lastSeenTxId: 3, lastChainTip: 5,
    listings: { [oldAnchor]: `0x${"b".repeat(64)}` }, deals: {} });
  await reindexAll({ log: () => {}, nodeDeployment: onPinnedChain });
  assert.equal(fromTx(), 0, "replayed from genesis");
  assert.ok(Object.hasOwn(store.loadScanState().listings, oldAnchor), "a legacy state is replayed, not reset");
  await reindexAll({ log: () => {}, nodeDeployment: onPinnedChain });
  assert.equal(fromTx(), 1, "the recorded chain makes the next pass incremental");
  assert.ok(Object.hasOwn(store.loadScanState().listings, oldAnchor));
});

test("same-chain tip regression resets only beyond the configured threshold", async () => {
  const CHAIN = "d".repeat(64);
  for (const [previousTip, reset] of [[2000, true], [500, false]] as const) {
    // An earlier zero-work pass retained the cursor but stored the replacement's low tip.
    store.saveScanState({ schemaVersion: SCAN_STATE_SCHEMA_VERSION, chainIdentity: CHAIN, lastSeenTxId: previousTip, lastChainTip: 5,
      listings: { [oldAnchor]: `0x${"b".repeat(64)}` }, deals: {} });
    const logs: string[] = [];
    await reindexAll({ log: (line) => logs.push(line), nodeDeployment: nodeOnChain(CHAIN) });
    assert.equal(Object.hasOwn(store.loadScanState().listings, oldAnchor), !reset);
    assert.equal(logs.some((line) => line.includes("chain replacement detected")), reset);
    assert.equal(store.loadScanState().chainIdentity, CHAIN);
  }
});

// A node re-pointed after the gate: the pass fails before it saves what it read since.
const CHANGED_CHAIN = "c".repeat(64);
const servedChainChanged = /catalog not updated: the served chain changed during the pass: WRONG_CHAIN: /;

test("a node that changes chain during the history scan fails the pass before its reads are saved", async () => {
  serveFiveTransactions();
  store.saveRegistrations([]);
  store.saveScanState({ ...oldChainState(), chainIdentity: NEW_CHAIN });
  store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [replacedChainSeller()] });
  const before = { state: store.loadScanState(), catalog: store.loadCatalog(), artifacts: store.indexerDiagnostics().artifacts };
  await assert.rejects(reindexAll({ log: () => {}, nodeDeployment: nodeServingInTurn(NEW_CHAIN, CHANGED_CHAIN) }), servedChainChanged);
  assert.deepEqual(store.loadScanState(), before.state);
  assert.deepEqual(store.loadCatalog(), before.catalog);
  assert.deepEqual(store.indexerDiagnostics().artifacts, before.artifacts);
  assert.equal(lastRunRow().status, "failed");
});

test("a node that changes chain while sellers are indexed saves no catalog and records no chain", async () => {
  serveFiveTransactions();
  store.saveRegistrations([]);
  store.clearChainDerivedArtifacts();
  store.saveScanState({ schemaVersion: SCAN_STATE_SCHEMA_VERSION, lastSeenTxId: 3, listings: {}, deals: {} });
  store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [replacedChainSeller()] });
  const catalog = store.loadCatalog();
  await assert.rejects(reindexAll({ log: () => {}, nodeDeployment: nodeServingInTurn(NEW_CHAIN, NEW_CHAIN, CHANGED_CHAIN) }),
    servedChainChanged);
  assert.deepEqual(store.loadCatalog(), catalog);
  assert.equal(store.loadScanState().chainIdentity, undefined);
  assert.equal(lastRunRow().status, "failed");
});

test("a low tip read after the node changed chain does not reset the cache", async () => {
  serveFiveTransactions();
  store.saveScanState({ schemaVersion: SCAN_STATE_SCHEMA_VERSION, chainIdentity: NEW_CHAIN, lastSeenTxId: 2000, lastChainTip: 5,
    listings: { [oldAnchor]: `0x${"b".repeat(64)}` }, deals: {} });
  const state = store.loadScanState();
  const logs: string[] = [];
  await assert.rejects(reindexAll({ log: (line) => logs.push(line), nodeDeployment: nodeServingInTurn(NEW_CHAIN, CHANGED_CHAIN) }),
    servedChainChanged);
  assert.deepEqual(store.loadScanState(), state);
  assert.equal(logs.some((line) => line.includes("chain replacement detected")), false);
  assert.equal(lastRunRow().status, "failed");
});

test("an anchor backfill read while the node served another chain is deferred, not saved", async () => {
  serveFiveTransactions();
  store.saveRegistrations([]);
  store.clearChainDerivedArtifacts();
  store.recordArtifact({ locator: `stor-${"9".repeat(40)}`, kind: "bundle", profile: "dacs-v0.1", contentHash: "9".repeat(64),
    observedAt: 1, data: {} });
  store.saveScanState({ schemaVersion: SCAN_STATE_SCHEMA_VERSION, chainIdentity: NEW_CHAIN, lastSeenTxId: 3, listings: {}, deals: {} });
  const logs: string[] = [];
  // Gate, history scan, backfill, then indexing: only the backfill saw the other chain.
  await reindexAll({ log: (line) => logs.push(line), nodeDeployment: nodeServingInTurn(NEW_CHAIN, NEW_CHAIN, CHANGED_CHAIN, NEW_CHAIN) });
  assert.ok(logs.some((line) => /^SR-2 anchor backfill deferred: the served chain changed during the pass: WRONG_CHAIN: /.test(line)));
  assert.equal(store.loadScanState().anchorBackfillComplete, false, "the backfill's progress is not saved");
});

test("a pass on a node with build drift logs the warning and completes", async () => {
  const warning = `Demos node build ${"f".repeat(40)} is not pinned`;
  const logs: string[] = [];
  await reindexAll({ log: (line) => logs.push(line), nodeDeployment: nodeOnChain("d".repeat(64), warning) });
  assert.ok(logs.includes(`node build warning: ${warning}`));
});
