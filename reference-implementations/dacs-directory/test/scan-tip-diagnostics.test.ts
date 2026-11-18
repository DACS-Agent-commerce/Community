import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import * as React from "react";

import { scanChain } from "../src/catalog/scan.js";
import { reindexAll } from "../src/catalog/reindexCore.js";
import * as store from "../src/catalog/store.js";
import { SCAN_STATE_SCHEMA_VERSION } from "../src/catalog/scanState.js";
import { chainResetRequired } from "../src/catalog/chainContinuity.js";
import { GET as status } from "../app/api/dacs/status/route.js";
import { CatalogStatusView, type Status } from "../src/components/CatalogStatus.js";
import { seedScanState } from "./fixtures/chain-state.js";
import { onPinnedChain } from "./fixtures/pinned-node.js";
import { PINNED_DEMOS_CHAIN_IDENTITY } from "../src/catalog/nodeDeployment.js";

const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as {
  renderToStaticMarkup: (element: React.ReactElement) => string;
};
Object.assign(globalThis, { React });
process.env.DACS_SCAN_FINALITY_DEPTH = "2";
const options = { nodeDeployment: onPinnedChain, crawlWellKnown: async () => ({ agents: [], errors: [] }), log: () => {} };
const reply = (response: unknown) => Response.json({ result: 200, response });
const five = [{ id: 5 }, { id: 4 }, { id: 3 }, { id: 2 }, { id: 1 }];
function seed(cursor: number, lastChainTip?: number | null) {
  seedScanState({ schemaVersion: SCAN_STATE_SCHEMA_VERSION, chainIdentity: PINNED_DEMOS_CHAIN_IDENTITY,
    lastSeenTxId: cursor, ...(lastChainTip === undefined ? {} : { lastChainTip }), listings: {}, deals: {} });
  store.saveRegistrations([]);
  store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [] });
}
function savedTip(): number | null | undefined {
  const db = new Database(join(store.DATA_DIR, "directory.sqlite"), { readonly: true });
  try {
    const row = db.prepare("SELECT value_json FROM kv_state WHERE key='scan-state'").get() as { value_json: string };
    return JSON.parse(row.value_json).lastChainTip;
  } finally { db.close(); }
}
const statusBody = async () => (await status(new NextRequest("https://directory.example/api/dacs/status"))).json();

test("an empty scan never reports its start cursor as an observed tip", async (t) => {
  t.mock.method(globalThis, "fetch", async () => reply([]));
  const scan = await scanChain(null, { sinceTxId: 77 });
  assert.equal(scan.chainTip, null);
  assert.equal(scan.observedTip, null);
  assert.equal(scan.highestTxId, 77);
  assert.equal(scan.complete, true);
});

test("invalid or absent numeric tips stay unknown", async (t) => {
  for (const page of [[{}], [{ id: -1 }], [{ id: 1.5 }], [{ id: Number.MAX_SAFE_INTEGER + 1 }]]) {
    const mock = t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) =>
      reply(JSON.parse(String(init?.body)).params[0].data.start === "latest" ? page : []));
    const scan = await scanChain(null, { sinceTxId: 77, maxTxs: 1 });
    assert.equal(scan.chainTip, null);
    assert.equal(scan.observedTip, null);
    mock.mock.restore();
  }
});

test("a scan stopped before any read has no diagnostic tip", async (t) => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("maxTxs zero must not read"));
  const scan = await scanChain(null, { sinceTxId: 77, maxTxs: 0 });
  assert.equal(scan.chainTip, null);
  assert.equal(scan.highestTxId, 77);
  assert.equal(scan.complete, false);
});

test("observed tips include zero and leave finality cursor arithmetic intact", async (t) => {
  for (const [page, tip, cursor] of [[five, 5, 3], [[{ id: 0 }], 0, 0]] as const) {
    const mock = t.mock.method(globalThis, "fetch", async () => reply(page));
    const scan = await scanChain(null, { sinceTxId: 0 });
    assert.equal(scan.chainTip, tip);
    assert.equal(scan.observedTip, tip);
    assert.equal(scan.highestTxId, cursor);
    assert.equal(scan.complete, true);
    mock.mock.restore();
  }
});

test("successful unknown replaces a previous known tip in state, run diagnostics and status", async (t) => {
  seed(77, 80);
  let preflight = true;
  t.mock.method(globalThis, "fetch", async () => {
    if (preflight) { preflight = false; return reply([{ id: 80 }]); }
    return reply([]);
  });
  const result = await reindexAll(options);
  assert.equal(result.cursor, 77);
  assert.equal(savedTip(), null, "the saved JSON records this run's unknown tip");
  assert.equal(store.loadScanState().lastChainTip, null);
  const body = await statusBody();
  assert.equal(body.indexer.lastRun.chain_tip, null);
  assert.equal(body.indexer.lastRun.status, "complete");
  assert.equal(body.indexer.lastRun.from_tx, 75, "the resume overlap is unchanged");
  assert.equal(body.indexer.lastRun.to_tx, 77);
  assert.equal(body.syncedToTx, 77);
  assert.equal(body.chainLatestTx, null);
  assert.equal(body.scanProgress.tip, null);
  assert.equal(body.scanProgress.lag, null);
  const markup = renderToStaticMarkup(React.createElement(CatalogStatusView, { status: body as Status }));
  assert.match(markup, /chain tip unknown/);
  assert.match(markup, /last scan tip: unknown/);
});

test("positive and zero observations survive state, SQLite run rows and status output", async (t) => {
  for (const [page, tip, cursor] of [[five, 5, 3], [[{ id: 0 }], 0, 0]] as const) {
    seed(0);
    const mock = t.mock.method(globalThis, "fetch", async () => reply(page));
    await reindexAll(options);
    assert.equal(savedTip(), tip);
    const body = await statusBody();
    assert.equal(body.indexer.lastRun.chain_tip, tip);
    assert.equal(body.indexer.lastRun.to_tx, cursor);
    assert.equal(body.scanProgress.tip, tip);
    assert.equal(body.chainLatestTx, tip);
    const markup = renderToStaticMarkup(React.createElement(CatalogStatusView, { status: body as Status }));
    assert.match(markup, new RegExp(`last scan tip: tx ${tip}`));
    assert.doesNotMatch(markup, /tip unknown|tip: unknown/);
    mock.mock.restore();
  }
});

test("first-page failure reports unknown and preserves prior saved state and publication", async (t) => {
  seed(77, 80);
  const before = store.loadScanState();
  const catalog = store.loadCatalog();
  t.mock.method(globalThis, "fetch", async () => { throw new Error("synthetic scan transport failure"); });
  await assert.rejects(reindexAll(options), /synthetic scan transport failure/);
  assert.deepEqual(store.loadScanState(), before);
  assert.deepEqual(store.loadCatalog(), catalog);
  assert.equal(savedTip(), 80);
  const body = await statusBody();
  assert.equal(body.indexer.lastRun.status, "failed");
  assert.equal(body.indexer.lastRun.chain_tip, null);
  assert.equal(body.indexer.lastRun.to_tx, 77);
});

for (const stop of ["error", "limit"] as const) {
  test(`a partial scan stopped by ${stop} records its observed tip without committing its cursor`, async (t) => {
    seed(0, 2);
    const prior = store.loadScanState();
    const oldMax = process.env.DACS_SCAN_MAX_TXS;
    if (stop === "limit") process.env.DACS_SCAN_MAX_TXS = "1";
    t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
      const data = JSON.parse(String(init?.body)).params[0].data;
      if (data.start !== "latest") throw new Error("synthetic next page failure");
      return reply([{ id: 8 }, { id: 7 }, { id: 6 }]);
    });
    try {
      await assert.rejects(reindexAll(options), stop === "error" ? /synthetic next page failure/ : /hit DACS_SCAN_MAX_TXS=1/);
      assert.deepEqual(store.loadScanState(), prior);
      const body = await statusBody();
      assert.equal(body.indexer.lastRun.status, "failed");
      assert.equal(body.indexer.lastRun.chain_tip, 8);
      assert.equal(body.indexer.lastRun.to_tx, 0);
      assert.equal(body.indexer.lastRun.txs_scanned, 1);
    } finally {
      if (oldMax === undefined) delete process.env.DACS_SCAN_MAX_TXS;
      else process.env.DACS_SCAN_MAX_TXS = oldMax;
    }
  });
}

test("failure after an empty scan keeps the previous known state but records an unknown run tip", async (t) => {
  seed(77, 80);
  t.mock.method(globalThis, "fetch", async () => reply([]));
  await assert.rejects(reindexAll({ ...options, log: (line) => {
    if (line.startsWith("chain scan:")) throw new Error("synthetic post-scan failure");
  } }), /synthetic post-scan failure/);
  assert.equal(savedTip(), 80);
  assert.equal(store.indexerDiagnostics().lastRun?.chain_tip, null);
});

test("saved tips remain readable; null never corroborates a reset and legacy missing is unchanged", () => {
  for (const tip of [undefined, null, 0, 80]) {
    seed(77, tip);
    assert.equal(store.loadScanState().lastChainTip, tip);
    assert.equal(savedTip(), tip);
  }
  for (const tip of [0, 400, 9990]) assert.equal(chainResetRequired({ lastSeenTxId: 10000, lastChainTip: null }, tip), false);
  assert.equal(chainResetRequired({ lastSeenTxId: 10000 }, 400), true, "legacy missing keeps its single-read behaviour");
  assert.equal(chainResetRequired({ lastSeenTxId: 10000 }, 9990), false);
  assert.equal(chainResetRequired({ lastSeenTxId: 10000, lastChainTip: 0 }, 400), true);
  assert.equal(chainResetRequired({ lastSeenTxId: 10000, lastChainTip: 10002 }, 400), false);
});

test("a pass that observed no tip cannot corroborate a reset; a later observed low tip still can", async (t) => {
  seed(10_000, 10_002);
  const logs: string[] = [];
  const run = (page: unknown[]) => {
    const mock = t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
      const start = JSON.parse(String(init?.body)).params?.[0]?.data?.start;
      return reply(start === undefined || start === "latest" ? page : []);
    });
    return reindexAll({ ...options, log: (line) => { logs.push(line); } }).finally(() => mock.mock.restore());
  };
  const resets = () => logs.filter((line) => line.startsWith("chain replacement detected")).length;
  await run([]);
  assert.equal(savedTip(), null);
  await run([{ id: 400 }]);
  assert.equal(resets(), 0, "one low read after an unobserved tip waits for corroboration");
  assert.equal(store.loadScanState().lastSeenTxId, 10_000);
  assert.equal(savedTip(), 400, "the pass saves the low tip it observed");
  await run([{ id: 400 }]);
  assert.equal(resets(), 1, "a second low observation still clears the cache");
  assert.equal(store.loadScanState().lastSeenTxId, 0);
});
