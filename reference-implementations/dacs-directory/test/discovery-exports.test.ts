import { revocationLogicalAddress } from "../src/catalog/listingVerification.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { sha256Hex } from "@kynesyslabs/dacs/canonical";
import type { Catalog, ListingSummary, SellerRecord } from "../src/catalog/types.js";

const directory = mkdtempSync(join(tmpdir(), "dacs-discovery-exports-"));
process.env.DACS_DIRECTORY_DATA = directory;
const { saveCatalog } = await import("../src/catalog/store.js");
const { GET: wellKnown } = await import("../app/api/dacs/wellknown-files/route.js");
const { GET: sellerView } = await import("../app/api/dacs/sellers/[primaryClaimRef]/route.js");
const { default: sitemap } = await import("../app/sitemap.js");
test.after(() => rmSync(directory, { recursive: true, force: true }));

const claim = `did:demos:agent:${"a".repeat(64)}`;
const listing = (id: string, rail: string, status: "active" | "revoked" = "active"): ListingSummary => ({
  listingId: id, version: 1, contentHash: "b".repeat(64), artifactProfile: "dacs-v0.1", status,
  anchor: { kind: "storage-program", locator: `stor-${sha256Hex(id).slice(0, 40)}` }, seller: { primaryClaim: claim, displayName: "Seller" },
  offering: { title: id, description: id, category: "test", tags: [], rails: [rail] }, pricing: {}, catalogObservedAt: 1,
} as ListingSummary);
const listings = [listing("old-dem", "pay-dem"), listing("old-x402", "pay-x402"),
  listing("native", "demos-native:DEM"), listing("x402", "x402:default"), listing("revoked", "demos-native:DEM", "revoked")];
listings[4].revocation = { sellerPrimaryClaim: claim, listingId: "revoked", listingVersion: 1,
  listingContentHash: listings[4].contentHash, logicalAddress: revocationLogicalAddress(claim, "revoked", 1),
  markerAnchor: { kind: "storage-program", locator: `stor-${"c".repeat(40)}` }, markerContentHash: "d".repeat(64) };
const seller = { primaryClaim: claim, displayName: "Seller", listings, deals: [], cci: [], lastIndexedAt: 1,
  reputation: { completed: 0, totalAgreements: 0 } } as unknown as SellerRecord;

test("machine discovery retains tombstones while skills and sitemap advertise executable offers", async () => {
  saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [seller] } as Catalog);
  const previous = globalThis.fetch;
  const read: string[] = [];
  globalThis.fetch = async (input) => {
    const locator = new URL(String(input)).pathname.split("/").pop()!;
    read.push(locator);
    return Response.json({ success: true, data: { listingId: locator } });
  };
  try {
    const response = await wellKnown(new NextRequest(`https://directory.example/api/dacs/wellknown-files?claim=${claim}&domain=agent.example&a2aEndpoint=https%3A%2F%2Fservice.example%2Fa2a&a2aTransport=HTTP%2BJSON`));
    assert.equal(response.status, 200);
    const { files } = await response.json();
    const index = JSON.parse(files["/.well-known/dacs/listings.json"]);
    const card = JSON.parse(files["/.well-known/agent-card.json"]);
    assert.equal(files["/.well-known/agent-card.json"], files["/.well-known/agent.json"]);
    assert.deepEqual(index.listings.map((l: ListingSummary) => l.listingId), ["native", "x402", "revoked"]);
    assert.equal(card.url, "https://service.example/a2a");
    assert.equal(card.preferredTransport, "HTTP+JSON");
    assert.deepEqual(index.listings[2].revocation, listings[4].revocation);
    assert.equal(Object.hasOwn(index.listings[0], "revocation"), false);
    assert.deepEqual(card.skills.map((s: { id: string }) => s.id), ["native", "x402"]);
    assert.equal(card.dacs.listings.indexHash, `sha256-${sha256Hex(files["/.well-known/dacs/listings.json"])}`);
    assert.deepEqual(read.filter((at) => at.startsWith("stor-")), listings.slice(2, 5).map((l) => l.anchor.locator), "executable offers and withdrawal records are exported");
    const view = await sellerView(new NextRequest("https://directory.example/api/dacs/sellers/agent"),
      { params: Promise.resolve({ primaryClaimRef: claim }) });
    assert.deepEqual((await view.json()).listings.map((l: ListingSummary) => l.listingId), ["native", "x402", "revoked"]);
    const urls = sitemap().map((entry) => entry.url);
    assert.equal(urls.filter((url) => url.includes("/service/")).length, 2);
    assert.ok(!urls.some((url) => /old-|revoked/.test(url)));
  } finally { globalThis.fetch = previous; }
});

test("an archival-only seller publishes no active skills, index entries or sitemap destinations", async () => {
  saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [{ ...seller, listings: listings.slice(0, 2) }] });
  const previous = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ result: 200, response: [] });
  try {
    const response = await wellKnown(new NextRequest(`https://directory.example/api/dacs/wellknown-files?claim=${claim}`));
    const { files } = await response.json();
    assert.deepEqual(JSON.parse(files["/.well-known/dacs/listings.json"]).listings, []);
    assert.deepEqual(JSON.parse(files["/.well-known/agent.json"]).skills, []);
    assert.equal(files["/.well-known/agent-card.json"], undefined);
    assert.equal(JSON.parse(files["/.well-known/agent.json"]).protocolVersion, undefined);
    assert.ok(!sitemap().some((entry) => /\/(?:service|seller)\//.test(entry.url)));
  } finally { globalThis.fetch = previous; }
});

test("A2A generation requires the service endpoint and its declared transport together", async () => {
  for (const query of ["a2aEndpoint=https://service.example/a2a", "a2aTransport=HTTP%2BJSON", "a2aEndpoint=http://service.example/a2a&a2aTransport=HTTP%2BJSON", "a2aEndpoint=https://service.example/a2a&a2aTransport=unknown"]) {
    assert.equal((await wellKnown(new NextRequest(`https://directory.example/api/dacs/wellknown-files?claim=${claim}&${query}`))).status, 400);
  }
});
