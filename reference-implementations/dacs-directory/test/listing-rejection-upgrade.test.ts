import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A directory.sqlite created by main's schema has listing_rejections without
// the listing_id/listing_version diagnostic columns; the store adds them in place.
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-rejection-upgrade-"));
const existingLocator = `stor-${"1".repeat(40)}`;
const existingClaim = `did:demos:agent:${"a".repeat(64)}`;
const seeded = new Database(join(dataDirectory, "directory.sqlite"));
seeded.exec(`
  CREATE TABLE listing_rejections (
    locator TEXT NOT NULL,
    registration_claim TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    occurrences INTEGER NOT NULL DEFAULT 1,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY(locator, registration_claim)
  );
`);
seeded.prepare("INSERT INTO listing_rejections VALUES (?, ?, 'OWNER_CLAIM_BINDING', 3, 1, 2)").run(existingLocator, existingClaim);
seeded.close();
process.env.DACS_DIRECTORY_DATA = dataDirectory;
const store = await import("../src/catalog/store.js");

test("the store upgrades main's listing_rejections table in place and keeps its rows", () => {
  const locator = `stor-${"2".repeat(40)}`;
  store.recordListingRejection(locator, `did:demos:agent:${"b".repeat(64)}`, "VERIFICATION_METHOD_INVALID", {
    listingId: "svc",
    listingVersion: 3,
  });
  const db = new Database(join(dataDirectory, "directory.sqlite"), { readonly: true });
  try {
    const columns = (db.prepare("PRAGMA table_info(listing_rejections)").all() as Array<{ name: string }>)
      .map((column) => column.name);
    assert.ok(columns.includes("listing_id"), columns.join(","));
    assert.ok(columns.includes("listing_version"), columns.join(","));
    const rows = db.prepare(
      "SELECT locator, reason_code, occurrences, listing_id, listing_version FROM listing_rejections ORDER BY locator",
    ).all();
    assert.deepEqual(rows, [
      { locator: existingLocator, reason_code: "OWNER_CLAIM_BINDING", occurrences: 3, listing_id: null, listing_version: null },
      { locator, reason_code: "VERIFICATION_METHOD_INVALID", occurrences: 1, listing_id: "svc", listing_version: 3 },
    ]);
  } finally {
    db.close();
  }
});
