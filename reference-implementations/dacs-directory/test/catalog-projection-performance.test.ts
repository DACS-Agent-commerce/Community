import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import test from "node:test";
import { noRateCatalog } from "./fixtures/no-rate-catalog.js";

const directory = mkdtempSync(join(tmpdir(), "dacs-projection-performance-"));
process.env.DACS_DIRECTORY_DATA = directory;
const { loadCatalog, loadStoredCatalog, saveCatalog, loadCatalogGeneratedAt } = await import("../src/catalog/store.js");
const { GET: health } = await import("../app/api/health/route.js");
test.after(() => rmSync(directory, { recursive: true, force: true }));

test("public reads avoid listing-by-deal rebuilding for 200 listings and 10,000 deals", (t) => {
  const catalog = noRateCatalog();
  const seller = catalog.sellers[0];
  const deal = seller.deals[1];
  seller.deals = Array.from({ length: 10_000 }, (_, index) => ({
    ...deal, jobId: `performance-${index}`, bundleContentHash: index.toString(16).padStart(64, "0"),
    settlementTxIds: [],
  }));
  seller.listings = Array.from({ length: 200 }, (_, index) => ({ ...seller.listings[0], listingId: `listing-${index}` }));
  saveCatalog(catalog);
  const start = performance.now();
  const first = loadCatalog();
  const coldMs = performance.now() - start;
  assert.equal(first.sellers[0].reputation.bundleCount, 10_000);
  assert.ok(first.sellers[0].listings.every((listing) => listing.reputationHint?.bundleCount === 10_000));
  assert.ok(coldMs < 2_500, `first projection took ${coldMs.toFixed(0)}ms; listing count must not multiply deal validation`);
  // The caller owns this copy, including its nested collections.
  first.sellers[0].deals.length = 0;
  first.sellers[0].listings[0].reputationHint!.bundleCount = 0;
  const warmStart = performance.now();
  const next = loadCatalog();
  const warmMs = performance.now() - warmStart;
  assert.equal(next.sellers[0].deals.length, 10_000);
  assert.equal(next.sellers[0].listings[0].reputationHint!.bundleCount, 10_000);
  assert.ok(warmMs < 1_000, `cached read took ${warmMs.toFixed(0)}ms`);
  assert.equal(loadStoredCatalog().sellers[0].reputation.completionRate, 0.95, "the cache never overwrites stored evidence");
  t.diagnostic(`10,000 deals × 200 listings: first ${coldMs.toFixed(0)}ms; cached ${warmMs.toFixed(0)}ms`);
});

test("projection cache notices external writes with an unchanged snapshot date and writer timestamp", () => {
  const catalog = noRateCatalog();
  saveCatalog(catalog);
  assert.equal(loadCatalog().sellers[0].reputation.totalAgreements, 6);
  const otherConnection = new Database(join(directory, "directory.sqlite"));
  try {
    // Deliberately preserve updated_at and generatedAt: neither is a revision key.
    catalog.sellers[0].deals[0].reputationEligible = false;
    otherConnection.prepare("UPDATE kv_state SET value_json = ? WHERE key = 'catalog'").run(JSON.stringify(catalog));
    const projected = loadCatalog();
    assert.equal(projected.sellers[0].reputation.totalAgreements, 5);
    assert.equal(projected.sellers[0].reputation.withheldRecordCount, 1);
    assert.equal(projected.sellers[0].listings[0].reputationHint!.bundleCount, 5);
    assert.equal(projected.sellers[0].reputation.completionRate, null);
  } finally {
    otherConnection.close();
  }
});

test("health reads only the snapshot date without projecting catalog evidence", async () => {
  const catalog = noRateCatalog();
  // An unrelated malformed cached record would fail the public projection.
  // Health still reads the stored snapshot date without walking its records.
  (catalog.sellers[0] as unknown as { deals: unknown[] }).deals = [null];
  saveCatalog(catalog);
  assert.equal(loadCatalogGeneratedAt(), 200);
  const response = await health();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, catalogGeneratedAt: 200 });
});
