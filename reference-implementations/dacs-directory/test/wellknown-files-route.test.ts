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

test("an aborted request stops the listing loop and does not read the remaining anchors", async () => {
  store.saveCatalog({
    catalogVersion: "1", generatedAt: 1,
    sellers: [{ primaryClaim: claim, displayName: "seller", listings: [listingRecord(11), listingRecord(12), listingRecord(13)] }] as never,
  });
  const reads: string[] = [];
  const controller = new AbortController();
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const loc = new URL(String(input)).pathname.split("/").pop() ?? "";
    reads.push(loc);
    if (loc === locator(11)) controller.abort();
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return Response.json({ success: true, owner: `0x${hex}`, programName: "opaque", data: { listingId: "ok" } });
  };
  try {
    const response = await GET(new NextRequest(`http://localhost/api/dacs/wellknown-files?claim=${claim}`, { signal: controller.signal }));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).files, undefined);
    assert.equal(reads.includes(locator(13)), false, "must not continue after abort");
  } finally { globalThis.fetch = original; }
});

test("the 30 s total deadline returns 503 instead of a partial index", async () => {
  store.saveCatalog({
    catalogVersion: "1", generatedAt: 1,
    sellers: [{ primaryClaim: claim, displayName: "seller", listings: [listingRecord(21), listingRecord(22)] }] as never,
  });
  const reads: string[] = [];
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const loc = new URL(String(input)).pathname.split("/").pop() ?? "";
    reads.push(loc);
    now += 31_000;
    return Response.json({ success: true, owner: `0x${hex}`, programName: "opaque", data: { listingId: "ok" } });
  };
  try {
    const response = await GET(new NextRequest(`http://localhost/api/dacs/wellknown-files?claim=${claim}`));
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.files, undefined);
    assert.match(body.error, /30 s/);
    assert.equal(reads.includes(locator(22)), false, "must not start the next read after the cap");
  } finally {
    Date.now = originalNow;
    globalThis.fetch = original;
  }
});


test("the final anchor read cannot cross the total deadline and return files", async () => {
  store.saveCatalog({
    catalogVersion: "1", generatedAt: 1,
    sellers: [{ primaryClaim: claim, displayName: "seller", listings: [listingRecord(31), listingRecord(32), listingRecord(33)] }] as never,
  });
  const originalNow = Date.now, originalFetch = globalThis.fetch;
  let now = 1_000_000, reads = 0;
  Date.now = () => now;
  globalThis.fetch = async (input) => {
    if (new URL(String(input)).pathname.includes("/storage-program/")) { now += 11_000; reads++; }
    return Response.json({ success: true, owner: `0x${hex}`, programName: "opaque", data: { listingId: "ok" } });
  };
  try {
    const response = await GET(new NextRequest(`http://localhost/api/dacs/wellknown-files?claim=${claim}`));
    console.log("FINAL_READ_STATUS", response.status, "ELAPSED_MS", now - 1_000_000, "READS", reads);
    assert.equal(reads, 3);
    assert.equal(now - 1_000_000, 33_000);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.files, undefined);
    assert.match(body.error, /30 s/);
  } finally { Date.now = originalNow; globalThis.fetch = originalFetch; }
});

// A reindex can remove an unread prior Listing from listings while retaining its version internally.
for (const visible of [false, true]) {
  for (const failure of ["denied", "missing", "outage"] as const) {
    test(`a ${failure} held anchor with ${visible ? "another visible listing" : "no visible listings"} answers 503`, async () => {
      store.saveCatalog({
        catalogVersion: "1", generatedAt: 1,
        sellers: [{ primaryClaim: claim, displayName: "seller", listings: visible ? [listingRecord(41)] : [],
          heldListingVersions: [{ locator: locator(42), listingId: "svc-42", version: 1, contentHash: "42".repeat(32) }],
        }] as never,
      });
      const original = globalThis.fetch;
      globalThis.fetch = async (input) => {
        if (String(input).endsWith(locator(42))) {
          if (failure === "missing") return Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
          return new Response(null, { status: failure === "denied" ? 403 : 503 });
        }
        return Response.json({ success: true, owner: `0x${hex}`, data: { listingId: "svc-41" } });
      };
      try {
        const response = await GET(new NextRequest(`http://localhost/api/dacs/wellknown-files?claim=${claim}`));
        assert.equal(response.status, 503);
        const body = await response.json();
        assert.equal(body.files, undefined);
        assert.match(body.error, /svc-42/);
      } finally { globalThis.fetch = original; }
    });
  }
}

for (const heldData of [null, { listingId: "rejected-content" }]) {
  test(`readable held ${heldData === null ? "non-object" : "object"} content does not block the index or become advertised`, async () => {
    store.saveCatalog({
      catalogVersion: "1", generatedAt: 1,
      sellers: [{ primaryClaim: claim, displayName: "seller", listings: [listingRecord(51)],
        heldListingVersions: [{ locator: locator(52), listingId: "svc-52", version: 1, contentHash: "52".repeat(32) }],
      }] as never,
    });
    const original = globalThis.fetch;
    globalThis.fetch = async (input) => Response.json({ success: true, owner: `0x${hex}`,
      data: String(input).endsWith(locator(52)) ? heldData : { listingId: "svc-51" } });
    try {
      const response = await GET(new NextRequest(`http://localhost/api/dacs/wellknown-files?claim=${claim}`));
      assert.equal(response.status, 200);
      const body = await response.json();
      const index = JSON.parse(body.files["/.well-known/dacs/listings.json"]);
      assert.deepEqual(index.listings.map((l: { listingId: string }) => l.listingId), ["svc-51"]);
      assert.equal(JSON.stringify(body).includes("heldListingVersions"), false);
      assert.equal(JSON.stringify(body).includes("svc-52"), false);
    } finally { globalThis.fetch = original; }
  });
}

for (const stop of ["abort", "deadline"] as const) {
  test(`held reads obey the existing ${stop} boundary and stop before the next anchor`, async () => {
    store.saveCatalog({
      catalogVersion: "1", generatedAt: 1,
      sellers: [{ primaryClaim: claim, displayName: "seller", listings: [],
        heldListingVersions: [61, 62].map((n) => ({ locator: locator(n), listingId: `svc-${n}`, version: 1, contentHash: "61".repeat(32) })),
      }] as never,
    });
    const originalFetch = globalThis.fetch, originalNow = Date.now;
    const controller = new AbortController();
    let now = 1_000_000;
    const reads: string[] = [];
    Date.now = () => now;
    globalThis.fetch = async (input, init) => {
      reads.push(String(input));
      assert.ok(init?.signal, "held reads must receive a signal");
      if (stop === "abort") { controller.abort(); assert.equal(init.signal.aborted, true); }
      else now += 31_000;
      return Response.json({ success: true, owner: `0x${hex}`, data: { listingId: "readable" } });
    };
    try {
      const response = await GET(new NextRequest(`http://localhost/api/dacs/wellknown-files?claim=${claim}`, { signal: controller.signal }));
      assert.equal(response.status, 503);
      assert.equal((await response.json()).files, undefined);
      assert.equal(reads.length, 1);
    } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
  });
}

test("readable all-held versions remain unadvertised and use the empty-catalog response", async () => {
  store.saveCatalog({
    catalogVersion: "1", generatedAt: 1,
    sellers: [{ primaryClaim: claim, displayName: "seller", listings: [],
      heldListingVersions: [1, 2].map((version) => ({ locator: locator(71), listingId: "svc-71", version, contentHash: "71".repeat(32) })),
    }] as never,
  });
  const original = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = async () => {
    reads++;
    return Response.json({ success: true, owner: `0x${hex}`, data: null });
  };
  try {
    const response = await GET(new NextRequest(`http://localhost/api/dacs/wellknown-files?claim=${claim}`));
    assert.equal(response.status, 404);
    assert.equal((await response.json()).files, undefined);
    assert.equal(reads, 1, "multiple held versions at one anchor share a read");
  } finally { globalThis.fetch = original; }
});
