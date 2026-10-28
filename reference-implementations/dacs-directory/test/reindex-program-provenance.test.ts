import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { nodeOnChain, nodeServingInTurn } from "./fixtures/pinned-node.js";

const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-program-provenance-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
process.env.DACS_SCAN_FINALITY_DEPTH = "0";
const originalFetch = globalThis.fetch;
const p = await import("./fixtures/program-replay.js");
const db = new Database(join(dataDirectory, "directory.sqlite"));
const child = (body: string) => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
  import assert from 'node:assert/strict';
  import * as p from './test/fixtures/program-replay.ts';
  p.serveHistory();
  ${body}
`], { encoding: "utf8", timeout: 30_000, env: process.env });
const restart = () => {
  const run = child("await p.replay(); p.assertAttributed();");
  assert.equal(run.status, 0, run.stderr || String(run.error));
};
test.after(() => {
  db.close();
  globalThis.fetch = originalFetch;
  delete process.env.DACS_SCAN_FINALITY_DEPTH;
  delete process.env.DACS_SCAN_MAX_TXS;
  rmSync(dataDirectory, { recursive: true, force: true });
});

for (const [name, programName] of [["agreement", p.agreementName], ["buyer bundle", p.bundleName]] as const) {
  for (const old of [p.staleAt, null]) test(`unlabeled ${name} ${old === null ? "ambiguity" : "singleton"} is rebuilt on the admitted chain`, async () => {
    p.seed({ [p.key(programName)]: old });
    await p.replay();
    p.assertAttributed();
  });
}

test("admission removes unvisited names of every kind from the saved dictionary", async () => {
  const names = ["dacs1:listing:absent", "dacs5:bundle:seller:absent", "dacs2:receipt:absent", "other:absent"];
  p.seed(Object.fromEntries(names.map((name, i) => [p.key(name), i % 2 ? null : p.staleAt])));
  await p.replay();
  p.assertAttributed();
  for (const name of names) assert.equal(Object.hasOwn(p.store.loadScanState().programs, p.key(name)), false, name);
});

for (const old of [p.staleAt, null]) test(`an unlabeled receipt ${old === null ? "ambiguity" : "singleton"} cannot block the current receipt route`, async () => {
  p.seed({ [p.key(p.receiptName)]: old });
  p.serveHistory(true);
  await p.replay();
  await p.assertReceipt();
});

test("empty and repeated current bindings resolve while proven duplicates remain indeterminate", async () => {
  for (const programs of [{}, { [p.key(p.agreementName)]: p.agreementAt }]) {
    p.seed(programs);
    await p.replay();
    p.assertAttributed();
    await p.replay();
    p.assertAttributed();
  }
  for (const ready of [true, false]) {
    p.seed({ [p.key(p.agreementName)]: p.staleAt }, true);
    if (!ready) p.store.invalidateCatalogChain(p.chainIdentity);
    await p.replay();
    assert.equal(p.store.loadScanState().programs[p.key(p.agreementName)], null);
    assert.equal(Object.values(p.store.loadScanState().deals)[0]?.owners.seller, "");
  }
});

for (const interruption of ["transport", "cap", "post-scan", "final-check"] as const) {
  test(`${interruption} refusal persists sanitation before adoption and a fresh process recovers attribution`, async () => {
    p.seed({ [p.key(p.agreementName)]: p.staleAt, [p.key("unvisited")]: null });
    const deployment = interruption === "post-scan" ? nodeServingInTurn(p.chainIdentity, p.chainIdentity, "c".repeat(64))
      : interruption === "final-check" ? nodeServingInTurn(p.chainIdentity, p.chainIdentity, p.chainIdentity, "c".repeat(64))
      : nodeOnChain(p.chainIdentity);
    if (interruption === "transport") globalThis.fetch = async () => { throw new Error("transport refused"); };
    if (interruption === "cap") process.env.DACS_SCAN_MAX_TXS = "1";
    try {
      await assert.rejects(p.replay(deployment), /chain scan failed|DACS_SCAN_MAX_TXS=1|served chain changed/);
      assert.deepEqual(p.store.loadCatalogChain(), { evidenceChain: p.chainIdentity, readySchema: null });
      const programs = p.store.loadScanState().programs;
      assert.equal(Object.hasOwn(programs, p.key("unvisited")), false);
      assert.notEqual(programs[p.key(p.agreementName)], p.staleAt);
    } finally { delete process.env.DACS_SCAN_MAX_TXS; p.serveHistory(); }
    restart();
  });
}

for (const cap of [1, 2, 3]) test(`a two-transaction replay with cap ${cap} sanitizes the cache at its limit boundary`, async () => {
  p.seed({ [p.key(p.agreementName)]: p.staleAt });
  process.env.DACS_SCAN_MAX_TXS = String(cap);
  try {
    if (cap === 1) {
      await assert.rejects(p.replay(), /DACS_SCAN_MAX_TXS=1/);
      assert.equal(p.store.loadCatalogChain()?.readySchema, null);
      assert.deepEqual(Object.keys(p.store.loadScanState().programs), []);
    } else { await p.replay(); p.assertAttributed(); }
  } finally { delete process.env.DACS_SCAN_MAX_TXS; }
});

test("a failed sanitation save leaves the cache unlabeled and retryable", async () => {
  p.seed({ [p.key(p.agreementName)]: p.staleAt });
  db.exec("CREATE TRIGGER refuse_sanitation BEFORE UPDATE ON kv_state WHEN old.key='scan-state' BEGIN SELECT RAISE(ABORT,'sanitation refused'); END");
  try {
    await assert.rejects(p.replay(), /sanitation refused/);
    assert.equal(p.store.loadCatalogChain(), null);
    assert.equal(p.store.loadScanState().programs[p.key(p.agreementName)], p.staleAt);
  } finally { db.exec("DROP TRIGGER refuse_sanitation"); }
  await p.replay();
  p.assertAttributed();
});

test("process death immediately after chain adoption cannot label the old namespace", () => {
  p.seed({ [p.key(p.agreementName)]: p.staleAt });
  const run = child(`
    const fetch = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      if (p.store.loadCatalogChain()?.evidenceChain === p.chainIdentity) process.kill(process.pid, 'SIGKILL');
      return fetch(...args);
    };
    await p.replay();
    throw new Error('adoption checkpoint not reached');
  `);
  assert.equal(run.signal, "SIGKILL", run.stderr);
  assert.deepEqual(p.store.loadCatalogChain(), { evidenceChain: p.chainIdentity, readySchema: null });
  assert.deepEqual(Object.keys(p.store.loadScanState().programs), []);
  restart();
});

test("overlapping production leases converge on the rebuilt namespace", async () => {
  p.seed({ [p.key(p.agreementName)]: p.staleAt });
  let release: () => void = () => {};
  const paused = new Promise<void>((resolve) => { release = resolve; });
  let entered: () => void = () => {};
  const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
  let secondEntered = false;
  const first = p.store.withDataLock("reindex", async () => { entered(); await paused; return p.replay(); });
  await firstEntered;
  const second = p.store.withDataLock("reindex", async () => { secondEntered = true; return p.replay(); });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(secondEntered, false, "the second caller waits for the first lease");
  release();
  await Promise.all([first, second]);
  assert.equal(secondEntered, true);
  p.assertAttributed();
});
