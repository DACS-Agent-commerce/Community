import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import type { Catalog, ListingSummary } from "../src/catalog/types.js";

process.env.DACS_DIRECTORY_DATA = mkdtempSync(join(tmpdir(), "dacs-query-bounds-"));
const { saveCatalog } = await import("../src/catalog/store.js");
const listings = await import("../app/api/dacs/listings/route.js");
const detail = await import("../app/api/dacs/listings/[listingId]/[version]/route.js");
const inspection = await import("../app/api/dacs/inspect-service/[listingId]/[version]/route.js");
const sellers = await import("../app/api/dacs/sellers/[primaryClaimRef]/route.js");
const claim = `did:demos:agent:${"a".repeat(64)}`;
const parameters = Array.from({ length: 1542 }, (_, i) => `k${String(i).padStart(4, "0")}=v`).join("&");
const presentedBy = `${claim}?${parameters}`;
const listing = (i: number): ListingSummary => ({
  listingId: `svc-${i}`, version: 1, contentHash: "c".repeat(64),
  anchor: { kind: "storage-program", locator: `stor-${i.toString(16).padStart(40, "0")}` },
  seller: { primaryClaim: presentedBy, displayName: "Seller" },
  offering: { title: "Service", category: "services.other", tags: [] },
  pricing: {}, status: "active", catalogObservedAt: 1,
});
const catalog = {
  catalogVersion: "1", generatedAt: 1,
  sellers: [{ primaryClaim: claim, displayName: "Seller", identityTier: "verified", listings: Array.from({ length: 100 }, (_, i) => listing(i)) }],
} as Catalog;

test("large primaryClaim and seller queries are rejected before catalog scanning", async () => {
  saveCatalog(catalog);
  const query = new URLSearchParams({ primaryClaim: presentedBy });
  assert.ok(query.toString().length >= 14_000);
  assert.equal((await listings.GET(new NextRequest(`https://directory.test/api/dacs/listings?${query}`))).status, 400);
  for (const primaryClaim of ["a".repeat(1024), "é".repeat(512)]) {
    assert.equal((await listings.GET(new NextRequest(`https://directory.test/api/dacs/listings?${new URLSearchParams({ primaryClaim })}`))).status, 200);
  }
  const params = Promise.resolve({ listingId: "svc-0", version: "1" });
  for (const route of [detail, inspection]) {
    for (const seller of ["a".repeat(1024), "é".repeat(512)]) {
      const request = new NextRequest(`https://directory.test/api/dacs/listings/svc-0/1?${new URLSearchParams({ seller })}`);
      assert.equal((await route.GET(request, { params })).status, 404);
    }
    for (const seller of [presentedBy, "a".repeat(1025), "é".repeat(513)]) {
      const request = new NextRequest(`https://directory.test/api/dacs/listings/svc-0/1?${new URLSearchParams({ seller })}`);
      assert.equal((await route.GET(request, { params })).status, 400);
    }
  }
  assert.equal((await listings.GET(new NextRequest(`https://directory.test/api/dacs/listings?${new URLSearchParams({ primaryClaim: "é".repeat(513) })}`))).status, 400);
});

test("seller-record identity drives filters and links while summaries retain exact presentedBy", async () => {
  saveCatalog(catalog);
  for (const primaryClaim of [claim, `${claim}?a=b`, "did:demos:agent"]) {
    const request = new NextRequest(`https://directory.test/api/dacs/listings?${new URLSearchParams({ primaryClaim, identityTier: "verified" })}`);
    const response = await listings.GET(request);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total, 100);
    assert.equal(body.listings[0].seller.primaryClaim, presentedBy);
    assert.equal(new URL(body.listings[0].inspection.href, "https://directory.test").searchParams.get("seller"), claim);
  }
  const response = await inspection.GET(new NextRequest(`https://directory.test/api/dacs/inspect-service/svc-0/1?${new URLSearchParams({ seller: `${claim}?a=b` })}`), {
    params: Promise.resolve({ listingId: "svc-0", version: "1" }),
  });
  assert.equal(response.status, 200);
});


test("seller path claims share the UTF-8 query bound and refuse malformed encoding", async () => {
  const request = new NextRequest("https://directory.test/api/dacs/sellers/test");
  for (const raw of ["a".repeat(1024), "é".repeat(512)]) {
    const response = await sellers.GET(request, { params: Promise.resolve({ primaryClaimRef: encodeURIComponent(raw) }) });
    assert.equal(response.status, 404, "a claim at the byte limit reaches lookup");
  }
  for (const raw of [presentedBy, "a".repeat(1025), "é".repeat(513)]) {
    const response = await sellers.GET(request, { params: Promise.resolve({ primaryClaimRef: encodeURIComponent(raw) }) });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "primaryClaim exceeds 1024 bytes" });
  }
  const malformed = await sellers.GET(request, { params: Promise.resolve({ primaryClaimRef: "%GG" }) });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "invalid primaryClaim encoding" });
});
