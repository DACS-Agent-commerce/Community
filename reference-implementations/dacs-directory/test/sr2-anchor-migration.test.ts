import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-sr2-migration-"));
const locator = `stor-${"7".repeat(40)}`;
const seeded = new Database(join(dataDirectory, "directory.sqlite"));
const seller = `did:demos:agent:${"8".repeat(64)}`;
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
seeded.prepare("INSERT INTO kv_state(key,value_json,updated_at) VALUES ('catalog',?,0)").run(JSON.stringify({
  catalogVersion: "1",
  generatedAt: 1_000,
  sellers: [{
    primaryClaim: seller,
    displayName: "migration seller",
    cci: [],
    listings: [{
      listingId: "listing-1",
      version: 1,
      contentHash: "ab".repeat(32),
      anchor: { kind: "storage-program", locator: `stor-${"9".repeat(40)}` },
      seller: { primaryClaim: seller, displayName: "migration seller" },
      offering: { title: "test", category: "test", tags: [] },
      pricing: {},
      status: "active",
      catalogObservedAt: 1,
      reputationHint: {
        categoryScope: "test", completionRate: 1, bundleCount: 1,
        windowStart: 0, windowEnd: 1_000, computedAt: 1_000,
      },
    }],
    deals: [{
      jobId: "job-1",
      rail: "pay-dem",
      buyerBundleRef: locator,
      owners: { buyer: `did:demos:agent:${"6".repeat(64)}`, seller },
      signatureVerified: true,
      refsVerified: true,
      sellerOutcome: "completed",
      finalisedAt: 100,
      verifiedAt: 200,
      reputationEligible: true,
      anchorTimestamp: 123,
    }],
    reputation: {
      completed: 1,
      bundleCount: 1,
      totalAgreements: 1,
      completionRate: 1,
      windowingBasis: "sr2-anchor-timestamp",
    },
    registeredAt: 1,
    lastIndexedAt: 1,
  }],
}));
seeded.close();

// The migration runs while store.ts is imported, so the test database must be
// selected first. This also prevents tests from touching checkout-local data.
process.env.DACS_DIRECTORY_DATA = dataDirectory;
const store = await import("../src/catalog/store.js");

test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));

test("SR-2 migration removes every legacy producer-controlled anchor time once", () => {
  assert.equal(store.artifactAnchorTime(locator), undefined);
  const catalog = store.loadCatalog();
  assert.equal(catalog.sellers[0]?.deals[0]?.anchorTimestamp, undefined);
  assert.equal(catalog.sellers[0]?.reputation.windowingBasis, "finalisedAt");
  assert.equal(catalog.sellers[0]?.reputation.bundleCount, 1);
  assert.equal(catalog.sellers[0]?.listings[0]?.reputationHint, undefined);
});
