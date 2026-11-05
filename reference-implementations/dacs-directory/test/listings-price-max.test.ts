import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import type { Catalog, ListingSummary } from "../src/catalog/types.js";
import { saveCatalog } from "../src/catalog/store.js";
import * as listings from "../app/api/dacs/listings/route.js";

const claim = `did:demos:agent:${"a".repeat(64)}`;
// Each priceHint differs from a priceMax below by less than binary64 resolves.
const priceHints = ["0.30000000000000001", "9007199254740993", "10000000000.000000001", "2.5"];
const listing = (priceHint: string, i: number): ListingSummary => ({
  listingId: `svc-${i}`, version: 1, contentHash: "c".repeat(64),
  anchor: { kind: "storage-program", locator: `stor-${i.toString(16).padStart(40, "0")}` },
  seller: { primaryClaim: claim, displayName: "Seller" },
  offering: { title: "Service", category: "services.other", tags: [] },
  pricing: { kind: "fixed", priceHint, currency: "DEM" }, status: "active", catalogObservedAt: 1,
});
saveCatalog({
  catalogVersion: "1", generatedAt: 1,
  sellers: [{ primaryClaim: claim, displayName: "Seller", listings: priceHints.map(listing) }],
} as Catalog);

const prices = async (priceMax: string) => {
  const response = await listings.GET(new NextRequest(
    `https://directory.test/api/dacs/listings?${new URLSearchParams({ priceMax })}`));
  assert.equal(response.status, 200, priceMax);
  // Sorted as strings, so "10000000000.000000001" precedes "2.5".
  return ((await response.json()).listings as ListingSummary[]).map((row) => row.pricing.priceHint).sort();
};

test("priceMax compares decimal strings exactly where binary64 rounds them together", async () => {
  assert.deepEqual(await prices("0.3"), []);
  assert.deepEqual(await prices("9007199254740992"), ["0.30000000000000001", "10000000000.000000001", "2.5"]);
  assert.deepEqual(await prices("10000000000"), ["0.30000000000000001", "2.5"]);
  assert.deepEqual(await prices("10000000000.000000000999"), ["0.30000000000000001", "2.5"]);
});

test("priceMax admits a priceHint equal to it, at any scale and at 9 decimals", async () => {
  assert.deepEqual(await prices("2.5"), ["0.30000000000000001", "2.5"]);
  assert.deepEqual(await prices("2.500000000"), ["0.30000000000000001", "2.5"]);
  assert.deepEqual(await prices("10000000000.000000001"), ["0.30000000000000001", "10000000000.000000001", "2.5"]);
  assert.deepEqual(await prices("9007199254740993"), [...priceHints].sort());
});

test("priceMax refuses a value that is not a non-negative decimal", async () => {
  for (const priceMax of ["-1", "+1", "1e2", "5e-1", "Infinity", "abc", "", ".", " 3", "3\n", "0x10", "1.2.3", "1,5"]) {
    const response = await listings.GET(new NextRequest(
      `https://directory.test/api/dacs/listings?${new URLSearchParams({ priceMax })}`));
    assert.equal(response.status, 400, priceMax);
    assert.deepEqual(await response.json(), { error: "priceMax is outside its allowed range" });
  }
});

test("priceMax accepts the SDK decimal grammar and canonicalizes it before comparing", async () => {
  const low = ["0.30000000000000001"];
  const upTo25 = ["0.30000000000000001", "2.5"];
  assert.deepEqual(await prices(".5"), low);
  assert.deepEqual(await prices("1."), low);
  assert.deepEqual(await prices("007"), upTo25);
  assert.deepEqual(await prices("00.5"), low);
  assert.deepEqual(await prices("0.50"), low);
  assert.deepEqual(await prices("02.50"), upTo25);
  assert.deepEqual(await prices("0"), []);
  assert.deepEqual(await prices("0."), []);
  assert.deepEqual(await prices(".30000000000000001"), low);
});
