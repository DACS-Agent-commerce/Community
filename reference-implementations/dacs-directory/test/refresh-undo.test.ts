// First: the store must open in a fresh directory, never the checkout's data/.
import { isolatedDataDir } from "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { catalogNodeDeployment } from "../src/catalog/listingFinality.js";
import { PINNED_DEMOS_CHAIN_IDENTITY } from "../src/catalog/nodeDeployment.js";
import { reindexAll } from "../src/catalog/reindexCore.js";
import { SCAN_STATE_SCHEMA_VERSION } from "../src/catalog/scanState.js";
import { loadCatalogChain, loadScanState, publishCatalogChain, saveDomains, saveRegistrations } from "../src/catalog/store.js";
import { nodeServingInTurn, onPinnedChain } from "./fixtures/pinned-node.js";
import { refuseCatalogWrites } from "./fixtures/refuse-catalog-writes.js";

// A refused or crashed refresh undoes every write it made from node reads, from the first one:
// the scan cursor, artifacts, candidates and replay progress, not only what indexing writes.
const OTHER_CHAIN = "aa".repeat(32);
const transactionHistory = [{ id: 5 }, { id: 4 }, { id: 3 }, { id: 2 }, { id: 1 }];
/** Five transactions, newest first; the history is the only node read once the deployment is injected. */
globalThis.fetch = async () => Response.json({ result: 200, response: transactionHistory });

const refreshWith = (nodeDeployment: typeof catalogNodeDeployment) => reindexAll({ log: () => {}, nodeDeployment });
const currentState = () => ({ schemaVersion: SCAN_STATE_SCHEMA_VERSION,
  lastSeenTxId: 1, lastChainTip: 5, listings: {}, deals: {} });
const savedCatalog = { catalogVersion: "1" as const, generatedAt: 7, sellers: [] };
/** Run history and leases are never undone; the journal's own table is bookkeeping. */
const NOT_UNDONE_TABLES = new Set(["scan_runs", "leases", "unconfirmed_chain_writes", "sqlite_sequence"]);

/** Exact evidence rows; chain provenance and readiness are asserted separately. */
function snapshot(): string {
  const db = new Database(join(isolatedDataDir, "directory.sqlite"), { readonly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>)
      .map((table) => table.name).filter((name) => !NOT_UNDONE_TABLES.has(name));
    return JSON.stringify(tables.map((table) => [table, db.prepare(
      `SELECT rowid, * FROM ${table}${table === "kv_state" ? " WHERE key != 'catalog-chain'" : ""} ORDER BY rowid`,
    ).all()]));
  } finally {
    db.close();
  }
}
function savePassInputs(): void {
  saveRegistrations([]);
  saveDomains([]);
  publishCatalogChain(savedCatalog, currentState(), PINNED_DEMOS_CHAIN_IDENTITY);
}
/** Refusal preserves provenance but requires a complete replay before the cache is current again. */
function assertReplayRequired(): void {
  assert.deepEqual(loadCatalogChain(), { evidenceChain: PINNED_DEMOS_CHAIN_IDENTITY, readySchema: null });
}

test("a pass whose chain holds advances the scan cursor and records it", async () => {
  savePassInputs();
  const before = snapshot();
  await refreshWith(onPinnedChain);
  assert.equal(loadScanState().lastSeenTxId, 3, "finality depth leaves the newest two transactions for replay");
  assert.deepEqual(loadCatalogChain(), { evidenceChain: PINNED_DEMOS_CHAIN_IDENTITY, readySchema: SCAN_STATE_SCHEMA_VERSION });
  assert.notEqual(snapshot(), before);
});

test("a pass whose last chain read fails restores evidence and requires replay", async () => {
  savePassInputs();
  const before = snapshot();
  await assert.rejects(refreshWith(nodeServingInTurn(PINNED_DEMOS_CHAIN_IDENTITY, PINNED_DEMOS_CHAIN_IDENTITY, OTHER_CHAIN)),
    /catalog not updated: the served chain changed during the pass: WRONG_CHAIN: /);
  assert.equal(loadScanState().lastSeenTxId, 1, "the cursor stays where the last complete pass left it");
  assertReplayRequired();
  assert.equal(snapshot(), before);
});

test("a pass whose catalog cannot be saved restores evidence and requires replay", async () => {
  savePassInputs();
  const before = snapshot();
  const allowCatalogWrites = refuseCatalogWrites(isolatedDataDir);
  try {
    await assert.rejects(refreshWith(onPinnedChain), /the catalog write failed/);
  } finally {
    allowCatalogWrites();
  }
  assertReplayRequired();
  assert.equal(snapshot(), before, "the scan cursor and the catalog are saved together or not at all");
});

test("a pass killed after it saved the scan cursor is undone by the next writer in a fresh process", async () => {
  savePassInputs();
  saveDomains(["https://seller.example"]);
  const before = snapshot();
  const killed = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { reindexAll } from "./src/catalog/reindexCore.ts";
    import { onPinnedChain } from "./test/fixtures/pinned-node.ts";
    globalThis.fetch = async () => Response.json({ result: 200, response: ${JSON.stringify(transactionHistory)} });
    // The crawl runs after the pass saved its scan state.
    await reindexAll({ log: () => {}, nodeDeployment: onPinnedChain,
      crawlWellKnown: async () => { process.kill(process.pid, "SIGKILL"); return { agents: [], errors: [] }; } });
  `], { encoding: "utf8", timeout: 30_000 });
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
  // A writer that refuses the node still reverts what the killed pass left behind first.
  const refusedNode: typeof catalogNodeDeployment = async () => ({ ok: false, reason: "Demos node serves another chain, not the pinned chain" });
  await assert.rejects(refreshWith(refusedNode), /catalog not updated: WRONG_CHAIN: /);
  assertReplayRequired();
  assert.equal(snapshot(), before);
});
