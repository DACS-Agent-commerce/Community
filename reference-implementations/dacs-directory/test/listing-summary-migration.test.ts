import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Catalog } from "../src/catalog/types.js";

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
  INSERT INTO kv_state(key,value_json,updated_at) VALUES ('listing-admission-schema-version','1',0);
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
      transactionReadiness: { disposition: "ready" },
      revocationBinding,
      catalogObservedAt: 1,
    }, {
      listingId: "listing-2",
      version: 1,
      status: "active",
      revocationBinding,
    }],
    deals: [],
    reputation: { completed: 0, bundleCount: 0, totalAgreements: 0, completionRate: null },
    registeredAt: 1,
    lastIndexedAt: 1,
  }],
}));
seeded.close();

// First store import happens in a fresh process, with the on-disk source active.
// A cached parent import must never stand in for startup migration coverage.
const startStore = () => {
  const child = spawnSync(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval",
    `const store = await import(${JSON.stringify(new URL("../src/catalog/store.ts", import.meta.url).href)});
     process.stdout.write(JSON.stringify(store.loadCatalog()));`,
  ], { env: { ...process.env, DACS_DIRECTORY_DATA: dataDirectory }, encoding: "utf8", timeout: 30_000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout) as Catalog;
};
const migrated = startStore();

test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));

test("persisted revocationBinding summaries migrate to normative revocation once", () => {
  const listing = migrated.sellers[0]?.listings[0];
  assert.deepEqual(listing?.revocation, revocationBinding);
  assert.equal("revocationBinding" in (listing ?? {}), false);
});

test("startup migrates ready and missing readiness summaries once across restarts", () => {
  const listings = migrated.sellers[0]?.listings;
  assert.equal(listings?.length, 2);
  for (const listing of listings ?? []) {
    assert.equal(listing.transactionReadiness?.disposition, "unassessed");
    assert.match(listing.transactionReadiness?.reason ?? "", /buyer-local/);
  }
  const db = new Database(join(dataDirectory, "directory.sqlite"), { readonly: true });
  try {
    const readMigration = () => db.prepare("SELECT * FROM kv_state WHERE key IN ('catalog', 'listing-summary-readiness-schema-version', 'listing-summary-revocation-schema-version') ORDER BY key").all();
    const before = readMigration();
    assert.equal((db.prepare("SELECT value_json FROM kv_state WHERE key='listing-summary-readiness-schema-version'").get() as { value_json: string }).value_json, "1");
    assert.equal((db.prepare("SELECT value_json FROM kv_state WHERE key='listing-summary-revocation-schema-version'").get() as { value_json: string }).value_json, "1");
    const persisted = JSON.parse((db.prepare("SELECT value_json FROM kv_state WHERE key='catalog'").get() as { value_json: string }).value_json);
    assert.deepEqual(persisted, migrated, "the migrated wire fields are durable, not just transformed on read");
    assert.deepEqual(startStore(), migrated, "restart reads the same migrated catalog");
    assert.deepEqual(readMigration(), before, "a restart does not rewrite the migrated catalog or version marker");
  } finally { db.close(); }
});

test("an active migrated row drops obsolete revocation evidence while revoked rows retain it", () => {
  const [revoked, active] = migrated.sellers[0].listings;
  assert.deepEqual(revoked.revocation, revocationBinding);
  assert.equal(Object.hasOwn(active, "revocationBinding"), false);
  assert.equal(Object.hasOwn(active, "revocation"), false);
});
