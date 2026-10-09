import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A database written before rejected and transient retries were counted
// separately: one shared retry_count, and rejection dead letters from older
// releases.
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-retry-migration-"));
const locator = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;
const [rejected, oldRejected, transient, exhausted] = [1, 2, 3, 4].map(locator);
const seeded = new Database(join(dataDirectory, "directory.sqlite"));
seeded.exec(`
  CREATE TABLE kv_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
  INSERT INTO kv_state(key,value_json,updated_at) VALUES ('schema-version','1',0), ('sr2-anchor-schema-version','2',0);
  CREATE TABLE artifacts (
    locator TEXT PRIMARY KEY, kind TEXT NOT NULL, profile TEXT NOT NULL, owner TEXT, content_hash TEXT,
    observed_at INTEGER NOT NULL, anchor_time INTEGER, status TEXT NOT NULL DEFAULT 'observed',
    error_code TEXT, error_message TEXT, retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at INTEGER, data_json TEXT
  );
  CREATE TABLE dead_letters (
    locator TEXT PRIMARY KEY, kind TEXT NOT NULL, error_code TEXT NOT NULL, error_message TEXT NOT NULL,
    attempts INTEGER NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
  );
`);
const insert = seeded.prepare(`INSERT INTO artifacts(locator,kind,profile,observed_at,status,error_code,error_message,retry_count,next_retry_at)
  VALUES (?,?,?,1,?,?,?,?,?)`);
insert.run(rejected, "other", "unknown", "retry", "ARTIFACT_REJECTED", "rejected", 4, 5_000);
insert.run(oldRejected, "listing-revocation", "unknown", "dead-letter", "ARTIFACT_REJECTED", "rejected", 5, null);
insert.run(transient, "unknown", "unknown", "retry", "STORAGE_RPC_UNAVAILABLE", "outage", 2, 6_000);
insert.run(exhausted, "unknown", "unknown", "dead-letter", "STORAGE_RPC_UNAVAILABLE", "outage", 5, null);
const deadLetter = seeded.prepare("INSERT INTO dead_letters VALUES (?,?,?,?,?,1,1)");
deadLetter.run(oldRejected, "listing-revocation", "ARTIFACT_REJECTED", "rejected", 5);
deadLetter.run(exhausted, "unknown", "STORAGE_RPC_UNAVAILABLE", "outage", 5);
seeded.close();

process.env.DACS_DIRECTORY_DATA = dataDirectory;
const store = await import("../src/catalog/store.js");

test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));

test("existing retry rows are split into rejected and transient classes in place", () => {
  assert.deepEqual(store.loadRetryableArtifacts(10_000), [transient, oldRejected, rejected], "transient retries first");
  const db = new Database(join(dataDirectory, "directory.sqlite"), { readonly: true });
  try {
    const row = (at: string) => db.prepare("SELECT status, retry_count, rejection_count FROM artifacts WHERE locator=?").get(at);
    assert.deepEqual(row(rejected), { status: "retry", retry_count: 0, rejection_count: 4 });
    assert.deepEqual(row(oldRejected), { status: "retry", retry_count: 0, rejection_count: 5 });
    assert.deepEqual(row(transient), { status: "retry", retry_count: 2, rejection_count: 0 });
    assert.deepEqual(row(exhausted), { status: "dead-letter", retry_count: 5, rejection_count: 0 });
    const deadLetters = db.prepare("SELECT locator FROM dead_letters ORDER BY locator").all();
    assert.deepEqual(deadLetters, [{ locator: exhausted }]);
  } finally { db.close(); }
});
