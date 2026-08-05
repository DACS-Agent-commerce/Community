import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-sr2-migration-"));
const locator = `stor-${"7".repeat(40)}`;
const seeded = new Database(join(dataDirectory, "directory.sqlite"));
seeded.exec(`
  CREATE TABLE kv_state (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO kv_state(key,value_json,updated_at) VALUES ('schema-version','1',0);
  CREATE TABLE artifacts (
    locator TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    profile TEXT NOT NULL,
    owner TEXT,
    content_hash TEXT,
    observed_at INTEGER NOT NULL,
    anchor_time INTEGER,
    status TEXT NOT NULL DEFAULT 'observed',
    error_code TEXT,
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER,
    data_json TEXT
  );
`);
seeded.prepare(`INSERT INTO artifacts(locator,kind,profile,observed_at,anchor_time,status,data_json)
  VALUES (?,?,?,?,?,'observed',?)`).run(locator, "bundle", "dacs-v0.1", 1, 123, JSON.stringify({ bundleVersion: "1" }));
seeded.close();

// The migration runs while store.ts is imported, so the test database must be
// selected first. This also prevents tests from touching checkout-local data.
process.env.DACS_DIRECTORY_DATA = dataDirectory;
const store = await import("../src/catalog/store.js");

test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));

test("SR-2 migration removes every legacy producer-controlled anchor time once", () => {
  assert.equal(store.artifactAnchorTime(locator), undefined);
});
