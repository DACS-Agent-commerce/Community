import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A database written by the previous release: separate retry classes, but more
// scheduled rejected retries than the ceiling, and a revocation candidate queue
// carried in scan-state JSON. Startup migrates both in place.
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-startup-"));
const locator = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;
const rejected = Array.from({ length: 1_030 }, (_, index) => locator(1 + index));
const listingHash = "a".repeat(64);
const listingOwner = `0x${"B".repeat(64)}`;
const [other, owned, unknown] = [locator(5_001), locator(5_002), locator(5_003)];
const seeded = new Database(join(dataDirectory, "directory.sqlite"));
seeded.exec(`
  CREATE TABLE kv_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
  INSERT INTO kv_state(key,value_json,updated_at) VALUES ('schema-version','1',0), ('sr2-anchor-schema-version','2',0);
  CREATE TABLE artifacts (
    locator TEXT PRIMARY KEY, kind TEXT NOT NULL, profile TEXT NOT NULL, owner TEXT, content_hash TEXT,
    observed_at INTEGER NOT NULL, anchor_time INTEGER, status TEXT NOT NULL DEFAULT 'observed',
    error_code TEXT, error_message TEXT, retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at INTEGER, data_json TEXT,
    rejection_count INTEGER NOT NULL DEFAULT 0, deferred_at INTEGER
  );
`);
const insert = seeded.prepare(`INSERT INTO artifacts(locator,kind,profile,observed_at,status,error_code,error_message,next_retry_at,rejection_count)
  VALUES (?,'other','unknown',1,'retry','ARTIFACT_REJECTED','rejected',?,1)`);
for (const [index, at] of rejected.entries()) insert.run(at, 1_000 + index);
const observed = seeded.prepare("INSERT INTO artifacts(locator,kind,profile,owner,content_hash,observed_at) VALUES (?,'listing-revocation','dacs-v0.1',?,?,1)");
observed.run(other, `0x${"c".repeat(64)}`, "1".repeat(64));
observed.run(owned, listingOwner, "2".repeat(64));
seeded.prepare("INSERT INTO kv_state(key,value_json,updated_at) VALUES ('scan-state',?,0)").run(JSON.stringify({
  schemaVersion: 9, lastSeenTxId: 7, listings: {}, deals: {}, programs: {},
  revocations: { [listingHash]: [other, owned, unknown] }, verifiedRevocations: {},
}));
seeded.close();

process.env.DACS_DIRECTORY_DATA = dataDirectory;
const store = await import("../src/catalog/store.js");

test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));

test("startup defers scheduled rejected retries beyond the ceiling, latest due first", () => {
  const db = new Database(join(dataDirectory, "directory.sqlite"), { readonly: true });
  try {
    const scheduled = db.prepare("SELECT locator FROM artifacts WHERE rejection_count > 0 AND deferred_at IS NULL ORDER BY next_retry_at")
      .all() as Array<{ locator: string }>;
    assert.deepEqual(scheduled.map((row) => row.locator), rejected.slice(0, store.MAX_ACTIVE_REJECTED_RETRIES));
    const waiting = db.prepare("SELECT locator FROM artifacts WHERE deferred_at IS NOT NULL AND next_retry_at IS NULL ORDER BY locator")
      .all() as Array<{ locator: string }>;
    assert.deepEqual(waiting.map((row) => row.locator), rejected.slice(store.MAX_ACTIVE_REJECTED_RETRIES));
  } finally { db.close(); }
  assert.equal(store.loadRetryableArtifacts(10_000).length, store.REJECTED_RETRY_READS_PER_PASS);
});

test("startup moves a candidate queue from scan state into the candidate store in order", () => {
  assert.deepEqual(Object.keys(store.loadScanState().revocations), []);
  assert.equal(store.loadScanState().lastSeenTxId, 7);
  // Arrival order is kept, and candidates anchored by the listing's owner come first.
  assert.deepEqual(store.nextRevocationCandidates(listingHash, null, 16), [other, owned, unknown]);
  assert.deepEqual(store.nextRevocationCandidates(listingHash, `did:demos:agent:${"b".repeat(64)}`, 16), [owned, other, unknown]);
  assert.deepEqual(store.nextRevocationCandidates(listingHash, null, 2), [other, owned]);
});
