import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dids, locator } from "./fixtures/current-evidence.js";

const directory = mkdtempSync(join(tmpdir(), "dacs-listing-admission-revoked-"));
process.env.DACS_DIRECTORY_DATA = directory;
test.after(() => rmSync(directory, { recursive: true, force: true }));

// A seller whose only Listing is a tombstone: no active summary exists to withhold.
const seller = dids[1];
const revokedListing = {
  listingId: "obsolete", version: 3, contentHash: "d".repeat(64),
  anchor: { kind: "storage-program", locator: locator(911) }, seller: { primaryClaim: seller, displayName: "Revoked seller" },
  offering: { title: "obsolete", category: "services.test", tags: [] }, pricing: {}, status: "revoked", catalogObservedAt: 1,
};
const cachedDeal = { jobId: "job-revoked", rail: "demos-native:DEM", buyerBundleRef: locator(912), sellerBundleRef: locator(913),
  owners: { buyer: dids[0], seller }, signatureVerified: true, refsVerified: true, reputationEligible: true,
  outcome: "completed", sellerOutcome: "completed", finalisedAt: 1, verifiedAt: 1 };
const reg = { primaryClaim: seller, displayName: "Revoked seller", listingAnchors: [locator(911)], deals: [] };
const seeded = new Database(join(directory, "directory.sqlite"));
seeded.exec("CREATE TABLE kv_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
const put = seeded.prepare("INSERT INTO kv_state VALUES (?, ?, 0)");
for (const [key, value] of Object.entries({
  "schema-version": 1, "sr2-anchor-schema-version": 2,
  "catalog": { catalogVersion: "1", generatedAt: 1, sellers: [{ ...reg, cci: [], listings: [revokedListing], deals: [cachedDeal],
    reputation: { completed: 1, totalAgreements: 1, completionRate: 1 }, registeredAt: 1, lastIndexedAt: 1 }] },
  "registrations": [reg], "scan-state": { lastSeenTxId: 0, listings: {}, deals: {} },
})) put.run(key, JSON.stringify(value));
seeded.close();

const store = await import("../src/catalog/store.js");

test("the reset withholds cached deal verdicts even when no active summary is withheld", () => {
  const [stored] = store.loadCatalog().sellers;
  assert.deepEqual(stored.listings.map((listing) => listing.listingId), ["obsolete"]);
  assert.deepEqual(stored.deals.map((deal) => [deal.jobId, deal.refsVerified, deal.reputationEligible]), [["job-revoked", false, false]]);
  assert.equal(stored.reputation.completed, 0);
});

test("the reset keeps the version of a tombstone so a later reindex that drops it cannot free the number", () => {
  assert.equal(store.listingVersionFloor(seller, "obsolete"), 3);
});
