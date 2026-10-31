import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import type { Catalog, ListingSummary } from "../src/catalog/types.js";
import { saveCatalog } from "../src/catalog/store.js";
import * as listings from "../app/api/dacs/listings/route.js";
import * as detail from "../app/api/dacs/listings/[listingId]/[version]/route.js";
import * as inspection from "../app/api/dacs/inspect-service/[listingId]/[version]/route.js";
import * as sellers from "../app/api/dacs/sellers/[primaryClaimRef]/route.js";

const claim = `did:demos:agent:${"a".repeat(64)}`;
// A summary carries the exact signed presentedBy, here with a CF-2 escaped reserved character.
const presentedBy = `${claim}?note=a%3Ab`;
const listing = (i: number): ListingSummary => ({
  listingId: `svc-${i}`, version: 1, contentHash: "c".repeat(64),
  anchor: { kind: "storage-program", locator: `stor-${i.toString(16).padStart(40, "0")}` },
  seller: { primaryClaim: presentedBy, displayName: "Seller" },
  offering: { title: "Service", category: "services.other", tags: [] },
  pricing: {}, status: "active", catalogObservedAt: 1,
});
const catalog = {
  catalogVersion: "1", generatedAt: 1,
  sellers: [{ primaryClaim: claim, displayName: "Seller", identityTier: "verified", listings: [listing(0), listing(1)] }],
} as Catalog;
saveCatalog(catalog);

const atBound = ["a".repeat(1024), "é".repeat(512)];
// One byte over in UTF-8 while far under 1024 characters, and a claim valid after trimming.
const overBound = ["a".repeat(1025), `${"é".repeat(512)}a`, `${claim}${" ".repeat(1025)}`];
const params = { params: Promise.resolve({ listingId: "svc-0", version: "1" }) };
const query = (path: string, name: string, value: string) =>
  new NextRequest(`https://directory.test${path}?${new URLSearchParams({ [name]: value })}`);

test("the listings route refuses a primaryClaim over 1024 raw UTF-8 bytes", async () => {
  assert.equal(Buffer.byteLength(overBound[2], "utf8"), 1105);
  for (const primaryClaim of atBound) {
    assert.equal((await listings.GET(query("/api/dacs/listings", "primaryClaim", primaryClaim))).status, 200);
  }
  for (const primaryClaim of overBound) {
    const response = await listings.GET(query("/api/dacs/listings", "primaryClaim", primaryClaim));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "primaryClaim exceeds 1024 bytes" });
  }
});

test("the detail and inspection routes refuse a seller over 1024 raw UTF-8 bytes", async () => {
  for (const [path, route] of [["/api/dacs/listings/svc-0/1", detail], ["/api/dacs/inspect-service/svc-0/1", inspection]] as const) {
    for (const seller of atBound) assert.equal((await route.GET(query(path, "seller", seller), params)).status, 404, path);
    for (const seller of overBound) {
      const response = await route.GET(query(path, "seller", seller), params);
      assert.equal(response.status, 400, `${path} ${seller.length}`);
      assert.deepEqual(await response.json(), { error: "seller exceeds 1024 bytes" });
    }
  }
});

test("the seller route refuses a decoded path claim over 1024 raw UTF-8 bytes", async () => {
  const request = new NextRequest("https://directory.test/api/dacs/sellers/x");
  for (const raw of atBound) {
    assert.equal((await sellers.GET(request, { params: Promise.resolve({ primaryClaimRef: raw }) })).status, 404);
  }
  for (const raw of overBound) {
    const response = await sellers.GET(request, { params: Promise.resolve({ primaryClaimRef: raw }) });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "primaryClaim exceeds 1024 bytes" });
  }
});

test("the seller route decodes a parameter-bearing claim once, keeping its reserved escape", async () => {
  for (const reference of [claim, presentedBy]) {
    const response = await sellers.GET(new NextRequest(`https://directory.test/api/dacs/sellers/${encodeURIComponent(reference)}`),
      { params: Promise.resolve({ primaryClaimRef: reference }) });
    assert.equal(response.status, 200, reference);
    assert.equal((await response.json()).listings.length, 2);
  }
});

test("primaryClaim and identityTier filters match a seller whose summaries carry parameters", async () => {
  for (const primaryClaim of [claim, `${claim}?other=x`, "did:demos:agent", ""]) {
    const response = await listings.GET(new NextRequest(
      `https://directory.test/api/dacs/listings?${new URLSearchParams({ primaryClaim, identityTier: "verified" })}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total, 2, primaryClaim);
    assert.equal(body.listings[0].seller.primaryClaim, presentedBy, "the summary keeps the exact presentedBy");
    assert.equal(new URL(body.listings[0].inspection.href, "https://directory.test").searchParams.get("seller"), claim);
  }
  const unmatched = await listings.GET(query("/api/dacs/listings", "primaryClaim", `did:demos:agent:${"b".repeat(64)}`));
  assert.equal((await unmatched.json()).total, 0);
});
