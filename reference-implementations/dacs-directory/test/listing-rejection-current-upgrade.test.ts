import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const directory = mkdtempSync(join(tmpdir(), "dacs-rejection-current-upgrade-"));
process.env.DACS_DIRECTORY_DATA = directory;
const db = new Database(join(directory, "directory.sqlite"));
db.exec(`CREATE TABLE listing_rejections (
  locator TEXT NOT NULL, registration_claim TEXT NOT NULL, reason_code TEXT NOT NULL,
  listing_id TEXT, listing_version INTEGER, occurrences INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  PRIMARY KEY(locator, registration_claim)
)`);
db.prepare("INSERT INTO listing_rejections VALUES (?, ?, ?, ?, 1, 1, 1, 1)").run(
  `stor-${"a".repeat(40)}`, `did:demos:agent:${"b".repeat(64)}`, "LISTING_SIGNATURE_INVALID", "unverified-name",
);
db.close();
const store = await import("../src/catalog/store.js");
test.after(() => rmSync(directory, { recursive: true, force: true }));

test("upgrading previous diagnostics discards unauthenticated coordinates and public eligibility", () => {
  const diagnostics = store.indexerDiagnostics().listingRejectionDiagnostics;
  assert.equal(diagnostics.total, 1);
  assert.equal(diagnostics.publicTotal, 0);
  assert.equal(diagnostics.items[0].listingId, undefined);
  assert.equal(diagnostics.items[0].listingVersion, undefined);
  assert.equal(diagnostics.items[0].publicNotice, false);
  store.pruneListingRejections([]);
  assert.equal(store.indexerDiagnostics().listingRejectionDiagnostics.total, 0);
});
