import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { catalogNodeDeployment } from "../src/catalog/listingFinality.js";
import { nodeOnChain } from "./fixtures/pinned-node.js";

const directory = mkdtempSync(join(tmpdir(), "dacs-chain-admission-"));
process.env.DACS_DIRECTORY_DATA = directory;
process.env.DACS_SCAN_RESET_THRESHOLD = "1000";
const originalFetch = globalThis.fetch;
const store = await import("../src/catalog/store.js");
const { reindexAll } = await import("../src/catalog/reindexCore.js");
const db = new Database(join(directory, "directory.sqlite"));
const chain = "a".repeat(64);
const locator = `stor-${"b".repeat(40)}`;
const programs = { [`0x${"c".repeat(64)}\ndacs3:agreement:old`]: locator, unvisited: null };
const legacyState = (cursor = 3) => ({ schemaVersion: 10, lastSeenTxId: cursor,
  listings: {}, deals: {}, programs, revocations: { ["d".repeat(64)]: [locator] } });

// Seed raw storage: seedScanState intentionally consumes the migration under test.
function seed(state: object = legacyState()): void {
  db.prepare("DELETE FROM kv_state WHERE key IN ('scan-state','catalog-chain','catalog','registrations')").run();
  db.prepare("DELETE FROM revocation_candidates").run();
  store.saveRegistrations([]);
  store.saveCatalog({ catalogVersion: "1", generatedAt: 7, sellers: [] });
  db.prepare("INSERT INTO kv_state(key,value_json,updated_at) VALUES ('scan-state',?,0)").run(JSON.stringify(state));
}
const evidence = () => ({
  state: db.prepare("SELECT * FROM kv_state ORDER BY key").all(),
  candidates: db.prepare("SELECT * FROM revocation_candidates ORDER BY listing_hash,locator").all(),
  artifacts: store.indexerDiagnostics().artifacts,
});
function history(failure = false): void {
  globalThis.fetch = async () => {
    if (failure) throw new Error("fetch failed");
    return Response.json({ result: 200, response: [5, 4, 3, 2, 1].map((id) => ({ id })) });
  };
}
const changed: typeof catalogNodeDeployment = nodeOnChain("e".repeat(64));
function afterInitial(verdict: typeof catalogNodeDeployment): typeof catalogNodeDeployment {
  let calls = 0;
  return async () => ++calls === 1 ? nodeOnChain(chain)() : verdict();
}
const refusal = /catalog not updated: the served chain changed during the pass: /;
async function expectPreserved(verdict: typeof catalogNodeDeployment = changed): Promise<void> {
  const before = evidence();
  await assert.rejects(reindexAll({ log: () => {}, nodeDeployment: afterInitial(verdict) }), refusal);
  assert.deepEqual(evidence(), before);
  assert.equal((db.prepare("SELECT status FROM scan_runs ORDER BY id DESC LIMIT 1").get() as { status: string }).status, "failed");
}

test.after(() => {
  db.close();
  globalThis.fetch = originalFetch;
  delete process.env.DACS_SCAN_RESET_THRESHOLD;
  delete process.env.DACS_SCAN_MAX_TXS;
  rmSync(directory, { recursive: true, force: true });
});

const refusals: Array<[string, typeof catalogNodeDeployment]> = [
  ["changed identity", changed],
  ["timeout", async () => { throw new DOMException("timed out", "TimeoutError"); }],
  ["transport", async () => { throw new TypeError("fetch failed"); }],
  ["unreadable genesis", async () => { throw new Error("Demos genesis block has no stable chain identity"); }],
];
for (const [name, verdict] of refusals) test(`pre-admission ${name} preserves legacy evidence and control`, async () => {
  seed(); history();
  await expectPreserved(verdict);
});

test("pre-admission refusal preserves the legacy queue even with no program bindings", async () => {
  seed({ ...legacyState(), programs: {} }); history();
  await expectPreserved();
});

for (const label of ["chainIdentity", "withheldChainIdentity"]) test(`pre-admission refusal does not consume raw ${label} migration`, async () => {
  seed({ ...legacyState(), [label]: chain }); history();
  await expectPreserved();
});

for (const cap of [4, 5, 6]) test(`pre-admission refusal precedes history scan at cap ${cap} around five transactions`, async () => {
  seed(); history();
  process.env.DACS_SCAN_MAX_TXS = String(cap);
  try { await expectPreserved(); }
  finally { delete process.env.DACS_SCAN_MAX_TXS; }
});

test("pre-admission refusal still runs after tip transport failure", async () => {
  seed(); history(true);
  await expectPreserved();
});

for (const regression of [999, 1000, 1001]) test(`pre-admission refusal preserves state at reset regression ${regression}`, async () => {
  seed(legacyState(5 + regression)); history();
  await expectPreserved();
});

test("a fresh process sees the original evidence after refused admission", async () => {
  seed(); history();
  const before = evidence();
  await assert.rejects(reindexAll({ log: () => {}, nodeDeployment: afterInitial(changed) }), refusal);
  assert.deepEqual(evidence(), before);
  const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import Database from 'better-sqlite3';
    import { join } from 'node:path';
    import * as store from './src/catalog/store.ts';
    const expected = JSON.parse(readFileSync(0, 'utf8'));
    assert.deepEqual({ ...store.loadScanState().programs }, expected.programs);
    // Startup migrates legacy candidates, preserving their evidence in the queue.
    const db = new Database(join(process.env.DACS_DIRECTORY_DATA, 'directory.sqlite'));
    assert.deepEqual(db.prepare('SELECT listing_hash,locator FROM revocation_candidates').all(),
      Object.entries(expected.revocations).flatMap(([listing_hash, locators]) => locators.map((locator) => ({ listing_hash, locator }))));
    db.close();
    assert.equal(store.loadCatalogChain(), null);
  `], { input: JSON.stringify(legacyState()), encoding: "utf8", timeout: 30_000, env: process.env });
  assert.equal(run.status, 0, run.stderr || String(run.error));
});

test("the next production lease observes original evidence after refused admission", async () => {
  seed(); history();
  const before = evidence();
  let release: () => void = () => {};
  const paused = new Promise<void>((resolve) => { release = resolve; });
  let entered: () => void = () => {};
  const atAdmission = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  const nodeDeployment: typeof catalogNodeDeployment = async () => {
    if (++calls === 1) return nodeOnChain(chain)();
    entered(); await paused;
    return changed();
  };
  const first = assert.rejects(store.withDataLock("reindex", () => reindexAll({ log: () => {}, nodeDeployment })), refusal);
  await atAdmission;
  let secondEntered = false;
  const second = store.withDataLock("reindex", async () => {
    secondEntered = true;
    assert.deepEqual(evidence(), before);
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(secondEntered, false);
  release();
  await Promise.all([first, second]);
  assert.equal(secondEntered, true);
});
