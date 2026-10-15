import assert from "node:assert/strict";
import test from "node:test";

import { homeCatalogDisplayState, homeCatalogSummary } from "../src/components/home-hero-state.js";
import type { Catalog } from "../src/catalog/types.js";

test("the homepage distinguishes indexing, indexed-empty, and populated catalogs", () => {
  assert.equal(homeCatalogDisplayState(false, 0), "indexing");
  assert.equal(homeCatalogDisplayState(true, 0), "empty");
  assert.equal(homeCatalogDisplayState(true, 1), "summary");
});

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const MINUTE = 60_000;

// Only the fields the summary reads; the rest of each record is irrelevant here.
function catalog(generatedAt: number, sellers: Array<{ statuses: string[]; deals: boolean[] }>): Catalog {
  return {
    catalogVersion: "1",
    generatedAt,
    sellers: sellers.map(({ statuses, deals }) => ({
      listings: statuses.map((status) => ({ status })),
      deals: deals.map((refsVerified) => ({ refsVerified })),
    })),
  } as unknown as Catalog;
}

test("the summary reports pending before the first index", () => {
  assert.deepEqual(homeCatalogSummary(catalog(0, []), NOW), {
    activeServices: 0,
    sellers: 0,
    verifiedDeals: 0,
    freshness: { value: "pending", label: "initial chain index" },
  });
});

test("an indexed catalog with no active listing says so", () => {
  const summary = homeCatalogSummary(catalog(NOW - 5 * MINUTE, [{ statuses: ["revoked"], deals: [true] }]), NOW);
  assert.deepEqual(summary, {
    activeServices: 0,
    sellers: 0,
    verifiedDeals: 0,
    freshness: { value: "5m", label: "last index; no active listings" },
  });
});

test("a populated catalog counts active services, their sellers, and verified deals only", () => {
  const summary = homeCatalogSummary(catalog(NOW - 2 * MINUTE, [
    { statuses: ["active", "active", "revoked"], deals: [true, false, true] },
    { statuses: ["active"], deals: [false, false] },
    { statuses: ["revoked"], deals: [true, true] },
  ]), NOW);
  assert.deepEqual(summary, {
    activeServices: 3,
    sellers: 2,
    verifiedDeals: 2,
    freshness: { value: "2m", label: "since last index" },
  });
});

test("the index age switches from minutes to hours at 60 minutes and never goes negative", () => {
  const age = (generatedAt: number) => homeCatalogSummary(catalog(generatedAt, [{ statuses: ["active"], deals: [] }]), NOW).freshness.value;
  assert.equal(age(NOW - 59 * MINUTE), "59m");
  assert.equal(age(NOW - 60 * MINUTE), "1h");
  assert.equal(age(NOW - 89 * MINUTE), "1h");
  assert.equal(age(NOW - 90 * MINUTE), "2h");
  assert.equal(age(NOW + 10 * MINUTE), "0m");
});
