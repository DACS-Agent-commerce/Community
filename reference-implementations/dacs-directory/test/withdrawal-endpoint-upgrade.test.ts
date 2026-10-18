import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const directory = mkdtempSync(join(tmpdir(), "dacs-withdrawal-endpoint-upgrade-"));
process.env.DACS_DIRECTORY_DATA = directory;
const claim = `did:demos:agent:${"a".repeat(64)}`;
const hash = "b".repeat(64), chainHash = "c".repeat(64);
const fabricated = `stor-${"d".repeat(40)}`, observed = `stor-${"e".repeat(40)}`;
const db = new Database(join(directory, "directory.sqlite"));
db.exec(`CREATE TABLE kv_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE revocation_candidates (listing_hash TEXT NOT NULL, locator TEXT NOT NULL, owner TEXT,
    content_hash TEXT, seq INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(listing_hash,locator));`);
const put = db.prepare("INSERT INTO kv_state VALUES (?, ?, 0)");
put.run("schema-version", "1"); put.run("sr2-anchor-schema-version", "2"); put.run("revocation-read-schema-version", "1");
put.run("withdrawal-carriage-schema-version", "2");
put.run("withdrawal-sources", JSON.stringify([{ domain: "https://thirdparty.example", seller: claim,
  hashes: [hash], incomplete: [hash], index: { generatedAt: 1, hash } }]));
put.run("scan-state", JSON.stringify({ schemaVersion: 10, lastSeenTxId: 100, listings: {}, deals: {} }));
put.run("catalog", JSON.stringify({ catalogVersion: "1", generatedAt: 1, sellers: [{ primaryClaim: claim,
  listings: [{ contentHash: hash, status: "active" }, { contentHash: chainHash, status: "revoked" }] }] }));
const insert = db.prepare("INSERT INTO revocation_candidates VALUES (?,?,?,?,?, 'pending')");
insert.run(hash, fabricated, null, null, 1);
insert.run(chainHash, observed, `0x${claim.slice(-64)}`, "f".repeat(64), 2);
db.close();
const store = await import("../src/catalog/store.js");
test.after(() => rmSync(directory, { recursive: true, force: true }));

test("upgrade removes endpoint-authorized v2 carriage and requires a full discovery replay", () => {
  assert.equal(store.hasPendingRevocationCandidates(hash), false, "fabricated unread carriage cannot survive upgrade");
  assert.equal(store.hasPendingRevocationCandidates(chainHash), true, "chain observations remain pending");
  assert.equal(store.loadScanState().schemaVersion, 0, "next successful scan must replay genesis");
  assert.equal(store.hasIncompleteWellKnownWithdrawal(claim, hash), true, "index-now cannot assert absence before replay");
  assert.deepEqual(store.loadCatalog().sellers[0].listings.map((l) => l.status), ["revoked"]);
  const upgraded = new Database(join(directory, "directory.sqlite"));
  assert.equal((upgraded.prepare("SELECT value_json FROM kv_state WHERE key='withdrawal-sources'").get() as { value_json: string }).value_json, "[]");
  upgraded.close();
  store.finishWithdrawalCarriageReplay();
  assert.equal(store.hasIncompleteWellKnownWithdrawal(claim, hash), false, "a successful replay releases the upgrade hold");
});
