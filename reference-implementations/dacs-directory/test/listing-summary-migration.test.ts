import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-listing-summary-migration-"));
const seller = `did:demos:agent:${"8".repeat(64)}`;
const listingId = "listing-1";
const listingContentHash = "a".repeat(64);
const revocationBinding = {
  sellerPrimaryClaim: seller,
  listingId,
  listingVersion: 1,
  listingContentHash,
  logicalAddress: `dacs1-revoked:${encodeURIComponent(seller)}:${listingId}:v1`,
  markerAnchor: { kind: "storage-program", locator: `stor-${"7".repeat(40)}` },
  markerContentHash: "b".repeat(64),
};
const seeded = new Database(join(dataDirectory, "directory.sqlite"));
seeded.exec(`
  CREATE TABLE kv_state (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO kv_state(key,value_json,updated_at) VALUES ('schema-version','1',0);
  INSERT INTO kv_state(key,value_json,updated_at) VALUES ('sr2-anchor-schema-version','2',0);
`);
seeded.prepare("INSERT INTO kv_state(key,value_json,updated_at) VALUES ('catalog',?,0)").run(JSON.stringify({
  catalogVersion: "1",
  generatedAt: 1_000,
  sellers: [{
    primaryClaim: seller,
    displayName: "migration seller",
    cci: [],
    listings: [{
      listingId,
      version: 1,
      contentHash: listingContentHash,
      anchor: { kind: "storage-program", locator: `stor-${"9".repeat(40)}` },
      seller: { primaryClaim: seller, displayName: "migration seller" },
      offering: { title: "test", category: "services.test", tags: [] },
      pricing: {},
      status: "revoked",
      revocationBinding,
      catalogObservedAt: 1,
    }],
    deals: [],
    reputation: { completed: 0, bundleCount: 0, totalAgreements: 0, completionRate: null },
    registeredAt: 1,
    lastIndexedAt: 1,
  }],
}));
seeded.close();

process.env.DACS_DIRECTORY_DATA = dataDirectory;
const store = await import("../src/catalog/store.js");

test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));

test("persisted revocationBinding summaries migrate to normative revocation once", () => {
  const listing = store.loadCatalog().sellers[0]?.listings[0];
  assert.deepEqual(listing?.revocation, revocationBinding);
  assert.equal("revocationBinding" in (listing ?? {}), false);
});
