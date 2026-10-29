import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import * as store from "../src/catalog/store.js";
import { SCAN_STATE_SCHEMA_VERSION } from "../src/catalog/scanState.js";
import { seedScanState } from "./fixtures/chain-state.js";

const A = "aa".repeat(32), B = "bb".repeat(32);
const catalog = { catalogVersion: "1" as const, generatedAt: 7, sellers: [] };
const state = { schemaVersion: SCAN_STATE_SCHEMA_VERSION, lastSeenTxId: 9, listings: {}, deals: {} };
const open = () => new Database(join(store.DATA_DIR, "directory.sqlite"));
const raw = () => {
  const db = open();
  try { return db.prepare("SELECT key,value_json FROM kv_state WHERE key IN ('scan-state','catalog','catalog-chain') ORDER BY key").all(); }
  finally { db.close(); }
};
function seed(): void {
  store.publishCatalogChain(catalog, state, A);
  store.recordArtifactFailure("stor-" + "1".repeat(40), "listing", "STORAGE_UNREADABLE", "old", 1);
  store.admitRevocationCandidates("2".repeat(64), [{ locator: "stor-" + "3".repeat(40) }]);
}

test("retired completed and withheld scanner labels migrate without losing provenance", () => {
  for (const withheld of [false, true]) {
    seedScanState({ ...state, ...(withheld ? { withheldChainIdentity: A } : { chainIdentity: A }) });
    assert.deepEqual(store.loadCatalogChain(), { evidenceChain: A, readySchema: withheld ? null : SCAN_STATE_SCHEMA_VERSION });
    assert.equal(store.loadScanState().chainIdentity, undefined);
    assert.equal(store.loadScanState().withheldChainIdentity, undefined);
    assert.deepEqual(store.loadCatalogChain(), { evidenceChain: A, readySchema: withheld ? null : SCAN_STATE_SCHEMA_VERSION });
  }
});

for (const operation of ["reset", "publish"] as const) {
  const targets = operation === "reset"
    ? ["listing-revocation", "listing_rejections", "dead_letters", "artifacts", "revocation_candidates", "catalog", "scan-state", "catalog-chain"]
    : ["scan-state", "catalog", "catalog-chain"];
  for (const target of targets) test(`${operation} rolls back when its ${target} statement fails`, () => {
    seed();
    const before = raw(), beforeArtifacts = store.indexerDiagnostics().artifacts;
    const db = open();
    const key = ["catalog", "scan-state", "catalog-chain"].includes(target);
    const table = key || target === "listing-revocation" ? "kv_state" : target;
    const event = key ? "UPDATE" : "DELETE";
    const condition = key ? ` WHEN old.key='${target}'` : target === "listing-revocation" ? " WHEN old.key LIKE 'listing-revocation:%'" : "";
    // Supply a retained row even when no Listing is present in the public catalog.
    db.prepare("INSERT OR REPLACE INTO kv_state(key,value_json,updated_at) VALUES ('listing-revocation:fixture','{}',0)").run();
    if (target === "listing_rejections") store.recordListingRejection("stor-" + "4".repeat(40), "seller", "OWNER_CLAIM_BINDING", { listingId: "svc", listingVersion: 1 }, true);
    db.exec(`CREATE TRIGGER fail_transition BEFORE ${event} ON ${table}${condition} BEGIN SELECT RAISE(ABORT,'transition refused'); END`);
    try {
      assert.throws(() => operation === "reset" ? store.resetCatalogChain(B, true, 3)
        : store.publishCatalogChain({ ...catalog, generatedAt: 8 }, { ...state, lastSeenTxId: 10 }, B), /transition refused/);
      assert.deepEqual(raw(), before);
      assert.deepEqual(store.indexerDiagnostics().artifacts, beforeArtifacts);
      assert.equal(store.loadCatalogChain()?.evidenceChain, A);
    } finally { db.exec("DROP TRIGGER fail_transition"); db.close(); }
  });
}

// Kill after every reset/publication statement, inside its real SQLite transaction.
for (const operation of ["reset", "publish"] as const) {
  for (let checkpoint = 1; checkpoint <= (operation === "reset" ? 8 : 3); checkpoint++) {
    test(`${operation} process death after statement ${checkpoint} exposes the previous complete state`, () => {
      seed();
      const before = raw();
      const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
        import Database from 'better-sqlite3';
        let armed = false, count = 0;
        const prepare = Database.prototype.prepare;
        Database.prototype.prepare = function(sql) {
          const statement = prepare.call(this, sql), run = statement.run;
          statement.run = function(...args) {
            const result = run.apply(this, args);
            if (armed && ++count === ${checkpoint}) process.kill(process.pid, 'SIGKILL');
            return result;
          };
          return statement;
        };
        const store = await import('./src/catalog/store.ts');
        armed = true;
        ${operation === "reset" ? `store.resetCatalogChain('${B}', true, 3);`
          : `store.publishCatalogChain(${JSON.stringify({ ...catalog, generatedAt: 8 })}, ${JSON.stringify(state)}, '${B}');`}
        throw new Error('checkpoint not reached');
      `], { encoding: "utf8", timeout: 30_000, env: process.env });
      assert.equal(child.signal, "SIGKILL", child.stderr);
      assert.deepEqual(raw(), before);
      assert.equal(store.loadCatalogChain()?.evidenceChain, A);
    });
  }
}

test("a completed reset binds the target without granting readiness and preserves publisher sources", () => {
  seed();
  store.saveRegistrations([{ primaryClaim: "seller", displayName: "Seller", listingAnchors: [] }]);
  store.saveDomains(["seller.example"]);
  store.recordWellKnownWithdrawalCheck("https://seller.example", "seller", ["f".repeat(64)], [], { generatedAt: 1, hash: "f".repeat(64) }, [], "publisher-signature", { anchor: "f".repeat(64) });
  store.resetCatalogChain(B, true, 3);
  assert.deepEqual(store.loadCatalogChain(), { evidenceChain: B, readySchema: null });
  assert.deepEqual(store.loadCatalog().sellers, []);
  assert.equal(store.loadScanState().lastSeenTxId, 0);
  assert.equal(store.loadRegistrations().length, 1);
  assert.equal(store.loadDomains().length, 1);
  assert.deepEqual(store.savedListingDeclarations("seller"), { sources: [{ anchor: "f".repeat(64) }], unknown: false });
});
