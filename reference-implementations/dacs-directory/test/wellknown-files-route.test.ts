import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { contentHash, stripSignature } from "@kynesyslabs/dacs/canonical";
import { legacyListingHash } from "../src/catalog/legacyListingHash.js";

process.env.DACS_DIRECTORY_DATA = mkdtempSync(join(tmpdir(), "dacs-directory-wellknown-route-"));
process.env.DEMOS_RPC = "https://node.test";
const store = await import("../src/catalog/store.js");
const { GET } = await import("../app/api/dacs/wellknown-files/route.js");

const hex = "ab".repeat(32);
const claim = `did:demos:agent:${hex}`;
const locator = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;
const listingRecord = (n: number) => ({
  listingId: `svc-${n}`, version: 1, status: "active", anchor: { kind: "storage-program", locator: locator(n) },
  offering: { title: `service ${n}`, category: "services.test", tags: [], description: "test service" }, pricing: {},
});

test("a stored listing with no canonical form is left out of the hosted index instead of failing the route", async () => {
  store.saveCatalog({
    catalogVersion: "1", generatedAt: 1,
    sellers: [{ primaryClaim: claim, displayName: "seller", listings: [listingRecord(1), listingRecord(2)] }] as never,
  });
  const stored: Record<string, string> = {
    // The read admits a fraction, but a Listing without dacsVersion hashes with the integer-only legacy profile.
    [locator(1)]: '{"listingId":"svc-1","price":1.5}',
    [locator(2)]: '{"listingId":"svc-2"}',
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const data = stored[new URL(String(input)).pathname.split("/").pop() ?? ""];
    return data === undefined ? new Response(null, { status: 503 })
      : new Response(`{"success":true,"owner":"0x${hex}","programName":"opaque","data":${data}}`, { headers: { "content-type": "application/json" } });
  };
  try {
    const response = await GET(new NextRequest(`http://localhost/api/dacs/wellknown-files?claim=${claim}`));
    assert.equal(response.status, 200);
    const files = (await response.json()).files as Record<string, string>;
    const listed = JSON.parse(files["/.well-known/dacs/listings.json"]).listings;
    assert.deepEqual(listed.map((entry: { listingId: string }) => entry.listingId), ["svc-2"]);
  } finally { globalThis.fetch = original; }
});

test("a node outage while reading a listing anchor answers 503 instead of an index with the listing missing", async () => {
  store.saveCatalog({
    catalogVersion: "1", generatedAt: 1,
    sellers: [{ primaryClaim: claim, displayName: "seller", listings: [listingRecord(5), listingRecord(6)] }] as never,
  });
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => new URL(String(input)).pathname.endsWith(locator(6))
    ? new Response(null, { status: 503 })
    : Response.json({ success: true, owner: `0x${hex}`, programName: "opaque", data: { listingId: "svc-5" } });
  try {
    const response = await GET(new NextRequest(`http://localhost/api/dacs/wellknown-files?claim=${claim}`));
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.files, undefined);
    assert.match(body.error, /svc-6/);
  } finally { globalThis.fetch = original; }
});

test("a node NOT_FOUND for an indexed listing anchor answers 503 instead of dropping the listing", async () => {
  store.saveCatalog({
    catalogVersion: "1", generatedAt: 1,
    sellers: [{ primaryClaim: claim, displayName: "seller", listings: [listingRecord(7)] }] as never,
  });
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
  try {
    const response = await GET(new NextRequest(`http://localhost/api/dacs/wellknown-files?claim=${claim}`));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).files, undefined);
  } finally { globalThis.fetch = original; }
});

test("a node reply refused by raw JSON admission answers 503 with its cause instead of dropping the listing", async () => {
  store.saveCatalog({
    catalogVersion: "1", generatedAt: 1,
    sellers: [{ primaryClaim: claim, displayName: "seller", listings: [listingRecord(8)] }] as never,
  });
  const original = globalThis.fetch;
  // 1e400 is not a binary64 number, so the SDK's raw admission refuses the whole reply.
  globalThis.fetch = async () => new Response(`{"success":true,"owner":"0x${hex}","programName":"opaque","data":{"listingId":"svc-8","future":1e400}}`);
  try {
    const response = await GET(new NextRequest(`http://localhost/api/dacs/wellknown-files?claim=${claim}`));
    assert.equal(response.status, 503);
    assert.match((await response.json()).reason, /raw JSON admission/);
  } finally { globalThis.fetch = original; }
});

test("hosted index hashes a historical Listing with its frozen profile and a current Listing with the current one", async () => {
  store.saveCatalog({
    catalogVersion: "1", generatedAt: 1,
    sellers: [{ primaryClaim: claim, displayName: "seller", listings: [listingRecord(3), listingRecord(4)] }] as never,
  });
  // A decomposed member name is where the two hash profiles differ.
  const historical = { agentId: claim, serviceId: "svc-3", "é": "member", signature: "00" };
  const current = { dacsVersion: "1", listingId: "svc-4", listingVersion: 1, "é": "member", signature: {} };
  const stored: Record<string, unknown> = { [locator(3)]: historical, [locator(4)]: current };
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const data = stored[new URL(String(input)).pathname.split("/").pop() ?? ""];
    return data === undefined ? new Response(null, { status: 503 })
      : Response.json({ success: true, owner: `0x${hex}`, programName: "opaque", data });
  };
  try {
    const response = await GET(new NextRequest(`http://localhost/api/dacs/wellknown-files?claim=${claim}`));
    const files = (await response.json()).files as Record<string, string>;
    const hashes = Object.fromEntries(JSON.parse(files["/.well-known/dacs/listings.json"]).listings
      .map((entry: { listingId: string; contentHash: string }) => [entry.listingId, entry.contentHash]));
    assert.equal(hashes["svc-3"], legacyListingHash(stripSignature(historical)));
    assert.notEqual(hashes["svc-3"], contentHash(stripSignature(historical)));
    assert.equal(hashes["svc-4"], contentHash(stripSignature(current)));
  } finally { globalThis.fetch = original; }
});
