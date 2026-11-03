// First: isolate persistent catalog state before importing the store.
import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { indexRegistration } from "../src/catalog/indexer.js";
import { signedScope } from "../src/catalog/evidenceGraph.js";
import { dids, locator, maps, sign, vector, type Obj } from "./fixtures/current-evidence.js";

function serveStorage(t: TestContext): void {
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const data = maps.get(String(input).split("/").pop() ?? "");
    return data ? Response.json({ success: true, owner: `0x${dids[1].slice(-64)}`, data })
      : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
  });
}

async function listings(t: TestContext, versions: number[]) {
  serveStorage(t);
  const fixture = await vector("supersession", 7000);
  const original = signedScope(fixture.listing, "listing");
  const anchors: string[] = [];
  for (const [index, version] of versions.entries()) {
    const scope: Obj = { ...original, listingVersion: version };
    const at = locator(7100 + index);
    maps.set(at, { ...scope, signature: await sign(scope, "listing", 1) });
    anchors.push(at);
  }
  return { anchors, registration: { primaryClaim: dids[1], displayName: "seller", listingAnchors: anchors, deals: [] } };
}
const offline = async (): Promise<never> => { throw new Error("identity unavailable"); };

test("a higher Listing version supersedes older active rows in either anchor order", async (t) => {
  const { anchors, registration } = await listings(t, [1, 2]);
  for (const listingAnchors of [anchors, [...anchors].reverse()]) {
    const record = await indexRegistration({ ...registration, listingAnchors }, undefined, offline);
    assert.deepEqual(record.listings.map(l => [l.version, l.status]).sort(), [[1, "superseded"], [2, "active"]]);
  }
});

test("distinct hashes at the highest version are ambiguous, with no fallback to older terms", async (t) => {
  const { anchors, registration } = await listings(t, [1, 2, 2]);
  const scope = signedScope(maps.get(anchors[2])!, "listing");
  scope.offering = { ...(scope.offering as Obj), title: "conflicting signed terms" };
  maps.set(anchors[2], { ...scope, signature: await sign(scope, "listing", 1) });
  for (const listingAnchors of [anchors, [...anchors].reverse()]) {
    const record = await indexRegistration({ ...registration, listingAnchors }, undefined, offline);
    assert.equal(record.listings.length, 3);
    assert.ok(record.listings.every(l => l.status === "superseded"));
  }
});

test("identical content at multiple anchors is not ambiguous", async (t) => {
  const { registration } = await listings(t, [1, 1]);
  const record = await indexRegistration(registration, undefined, offline);
  assert.equal(record.listings.length, 1);
  assert.ok(record.listings.every(l => l.status === "active"));
});

test("a single version remains active, and different listing IDs are independent", async (t) => {
  const { anchors, registration } = await listings(t, [1, 2]);
  const scope = signedScope(maps.get(anchors[1])!, "listing");
  scope.listingId = "other-service";
  maps.set(anchors[1], { ...scope, signature: await sign(scope, "listing", 1) });
  const single = await indexRegistration({ ...registration, listingAnchors: [anchors[0]] }, undefined, offline);
  assert.deepEqual(single.listings.map(l => [l.version, l.status]), [[1, "active"]]);
  const independent = await indexRegistration(registration, undefined, offline);
  assert.deepEqual(independent.listings.map(l => [l.listingId, l.status]), [["svc", "active"], ["other-service", "active"]]);
});

test("an expired successor does not reactivate prior terms, and invalid bytes cannot supersede", async (t) => {
  const { anchors, registration } = await listings(t, [1, 2]);
  const scope = signedScope(maps.get(anchors[1])!, "listing");
  scope.validity = { notBefore: 1, notAfter: 2 };
  maps.set(anchors[1], { ...scope, signature: await sign(scope, "listing", 1) });
  const expired = await indexRegistration(registration, undefined, offline);
  assert.deepEqual(expired.listings.map(l => [l.version, l.status]), [[1, "superseded"]]);
  maps.set(anchors[1], { ...maps.get(anchors[1]), listingVersion: 3 });
  const invalid = await indexRegistration(registration, undefined, offline);
  assert.deepEqual(invalid.listings.map(l => [l.version, l.status]), [[1, "active"]]);
});

test("catalog and well-known discovery omit superseded rows while exact version lookup preserves signed bytes", async (t) => {
  const { NextRequest } = await import("next/server");
  const { GET: search } = await import("../app/api/dacs/listings/route.js");
  const { GET: exact } = await import("../app/api/dacs/listings/[listingId]/[version]/route.js");
  const { saveCatalog } = await import("../src/catalog/store.js");
  const { activeCatalogListings } = await import("../src/catalog/discovery.js");
  const { listingSummarySchema } = await import("../src/catalog/contracts.js");
  const { anchors, registration } = await listings(t, [1, 2]);
  for (const anchor of anchors) {
    const scope = signedScope(maps.get(anchor)!, "listing");
    scope.acceptedRails = [{ railId: "demos-native:DEM" }];
    scope.pipeline = (scope.pipeline as Obj[]).map(phase => phase.kind === "pay-dem"
      ? { ...phase, parameters: { rail: "demos-native:DEM" } } : phase);
    maps.set(anchor, { ...scope, signature: await sign(scope, "listing", 1) });
  }
  const record = await indexRegistration(registration, undefined, offline);
  const catalog = { catalogVersion: "1" as const, generatedAt: Date.now(), sellers: [record] };
  saveCatalog(catalog);
  assert.deepEqual(activeCatalogListings(catalog).map(l => l.version), [2]);
  assert.deepEqual(listingSummarySchema.properties.status.enum, ["active", "revoked"]);
  const response = await search(new NextRequest("https://directory.example/api/dacs/listings?q=test"));
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.deepEqual(page.listings.map((l: { version: number; status: string }) => [l.version, l.status]),
    [[2, "active"]]);
  const { queryListingCatalog, createCatalogBindingIndex } = await import("../vendor/dacs-sdk/dist/discovery/catalog.js");
  const { listingAddress } = await import("@kynesyslabs/dacs/canonical");
  const client = { catalogUrl: "https://directory.example/api/dacs/listings", fetchImpl: async () => Response.json(page) };
  const { GET: sellerView } = await import("../app/api/dacs/sellers/[primaryClaimRef]/route.js");
  const sellerResponse = await sellerView(new NextRequest(`https://directory.example/api/dacs/sellers/${dids[1]}`),
    { params: Promise.resolve({ primaryClaimRef: dids[1] }) });
  assert.equal(sellerResponse.status, 200);
  assert.deepEqual((await sellerResponse.json()).listings.map((l: { version: number; status: string }) => [l.version, l.status]), [[2, "active"]]);
  const parsed = await queryListingCatalog(client);
  assert.equal(parsed.status, "ok", JSON.stringify(parsed));
  const resolved = await createCatalogBindingIndex(client).resolve(listingAddress(dids[1], "svc", 2), dids[1].slice(-64));
  assert.equal(resolved.status, "present", JSON.stringify(resolved));
  assert.equal(resolved.status === "present" && resolved.binding.nativeAddress, anchors[1]);
  const { GET: wellknown } = await import("../app/api/dacs/wellknown-files/route.js");
  const hosted = await wellknown(new NextRequest(`https://directory.example/api/dacs/wellknown-files?claim=${dids[1]}`));
  assert.equal(hosted.status, 200);
  const entries = JSON.parse((await hosted.json()).files["/.well-known/dacs/listings.json"]).listings;
  assert.deepEqual(entries.map((l: { version: number; status: string }) => [l.version, l.status]), [[2, "active"]]);
  for (const [index, version] of ["1", "2"].entries()) {
    const historical = await exact(new NextRequest(`https://directory.example/api/dacs/listings/svc/${version}`),
      { params: Promise.resolve({ listingId: "svc", version }) });
    assert.equal(historical.status, 200);
    assert.deepEqual(await historical.json(), maps.get(anchors[index]));
  }
});

test("a revoked highest version keeps its withdrawal status and supersedes the older row", async (t) => {
  const { admitRevocationCandidates } = await import("../src/catalog/store.js");
  const { artifactHash } = await import("../src/catalog/evidenceGraph.js");
  const { contentHash } = await import("@kynesyslabs/dacs/canonical");
  const { ed25519Sign, privateKeyFromSeed } = await import("@kynesyslabs/dacs/crypto");
  const { seeds } = await import("./fixtures/current-evidence.js");
  const { anchors, registration } = await listings(t, [1, 2]);
  const hash = artifactHash(maps.get(anchors[1])!, "listing");
  const scope = { listingId: "svc", listingVersion: 2, listingContentHash: hash, revokedAt: Date.now() - 1 };
  const value = Buffer.from(ed25519Sign(Buffer.from(`dacs-revocation:v1:${contentHash(scope)}`), privateKeyFromSeed(seeds[1]))).toString("base64url");
  const marker = locator(7200);
  maps.set(marker, { ...scope, signature: { algorithm: "ed25519", signer: dids[1], value } });
  admitRevocationCandidates(hash, [{ locator: marker, owner: `0x${dids[1].slice(-64)}` }]);
  const record = await indexRegistration(registration, undefined, offline);
  assert.deepEqual(record.listings.map(l => [l.version, l.status]), [[1, "superseded"], [2, "revoked"]]);
  assert.ok(record.listings[1].revocation);
  const { saveCatalog } = await import("../src/catalog/store.js");
  const { NextRequest } = await import("next/server");
  const { GET: wellknown } = await import("../app/api/dacs/wellknown-files/route.js");
  saveCatalog({ catalogVersion: "1", generatedAt: Date.now(), sellers: [record] });
  const response = await wellknown(new NextRequest(`https://directory.example/api/dacs/wellknown-files?claim=${dids[1]}`));
  assert.equal(response.status, 200);
  const entries = JSON.parse((await response.json()).files["/.well-known/dacs/listings.json"]).listings;
  assert.deepEqual(entries.map((l: { version: number; status: string }) => [l.version, l.status]), [[2, "revoked"]]);
  assert.deepEqual(entries[0].revocation, record.listings[1].revocation);
});

test("legacy Listing versions use numeric ordering too", async (t) => {
  const { readFileSync } = await import("node:fs");
  const { legacyListingHash } = await import("../src/catalog/legacyListingHash.js");
  const { ed25519Sign, privateKeyFromSeed } = await import("@kynesyslabs/dacs/crypto");
  const { seeds } = await import("./fixtures/current-evidence.js");
  serveStorage(t);
  const { signature: _signature, ...original } = JSON.parse(readFileSync(new URL("./fixtures/reviewbot-listing-anchor.json", import.meta.url), "utf8")).data;
  const anchors: string[] = [];
  for (const version of [2, 10]) {
    const scope = { ...original, agentId: dids[1], listingVersion: version };
    const signature = Buffer.from(ed25519Sign(Buffer.from(`dacs-listing:v1:${legacyListingHash(scope)}`), privateKeyFromSeed(seeds[1]))).toString("base64url");
    const at = locator(7300 + version);
    maps.set(at, { ...scope, signature });
    anchors.push(at);
  }
  const record = await indexRegistration({ primaryClaim: dids[1], displayName: "seller", listingAnchors: anchors, deals: [] }, undefined, offline);
  assert.deepEqual(record.listings.map(l => [l.version, l.status]), [[2, "superseded"], [10, "active"]]);
});

test("a successor supersedes only when its notBefore arrives in either anchor order", async (t) => {
  const { anchors, registration } = await listings(t, [1, 2]);
  const scope = signedScope(maps.get(anchors[1])!, "listing");
  const start = Date.now() + 86_400_000;
  scope.validity = { notBefore: start };
  maps.set(anchors[1], { ...scope, signature: await sign(scope, "listing", 1) });
  for (const listingAnchors of [anchors, [...anchors].reverse()]) {
    t.mock.method(Date, "now", () => start - 1);
    const before = await indexRegistration({ ...registration, listingAnchors }, undefined, offline);
    assert.deepEqual(before.listings.map(l => [l.version, l.status]), [[1, "active"]]);
    t.mock.method(Date, "now", () => start);
    const valid = await indexRegistration({ ...registration, listingAnchors }, before, offline);
    assert.deepEqual(valid.listings.map(l => [l.version, l.status]).sort(), [[1, "superseded"], [2, "active"]]);
  }
});

test("a revoked lower version keeps its withdrawal status under an active successor", async (t) => {
  const { admitRevocationCandidates, saveCatalog } = await import("../src/catalog/store.js");
  const { artifactHash } = await import("../src/catalog/evidenceGraph.js");
  const { contentHash } = await import("@kynesyslabs/dacs/canonical");
  const { ed25519Sign, privateKeyFromSeed } = await import("@kynesyslabs/dacs/crypto");
  const { seeds } = await import("./fixtures/current-evidence.js");
  // Versions unused above: revocation and scan state persist across this file's tests.
  const { anchors, registration } = await listings(t, [3, 4]);
  const hash = artifactHash(maps.get(anchors[0])!, "listing");
  const scope = { listingId: "svc", listingVersion: 3, listingContentHash: hash, revokedAt: Date.now() - 1 };
  const value = Buffer.from(ed25519Sign(Buffer.from(`dacs-revocation:v1:${contentHash(scope)}`), privateKeyFromSeed(seeds[1]))).toString("base64url");
  const marker = locator(7201);
  maps.set(marker, { ...scope, signature: { algorithm: "ed25519", signer: dids[1], value } });
  admitRevocationCandidates(hash, [{ locator: marker, owner: `0x${dids[1].slice(-64)}` }]);
  const record = await indexRegistration(registration, undefined, offline);
  assert.deepEqual(record.listings.map(l => [l.version, l.status]), [[3, "revoked"], [4, "active"]]);
  const { NextRequest } = await import("next/server");
  const { GET: wellknown } = await import("../app/api/dacs/wellknown-files/route.js");
  saveCatalog({ catalogVersion: "1", generatedAt: Date.now(), sellers: [record] });
  const response = await wellknown(new NextRequest(`https://directory.example/api/dacs/wellknown-files?claim=${dids[1]}`));
  assert.equal(response.status, 200);
  const entries = JSON.parse((await response.json()).files["/.well-known/dacs/listings.json"]).listings;
  assert.deepEqual(entries.map((l: { version: number; status: string }) => [l.version, l.status]), [[3, "revoked"], [4, "active"]]);
  assert.deepEqual(entries[0].revocation, record.listings[0].revocation);
});

test("an unreadable successor anchor keeps superseding the versions it listed on the prior pass", async (t) => {
  const down = new Map<string, Response>();
  const { anchors, registration } = await listings(t, [5, 6, 6]);
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const at = String(input).split("/").pop() ?? "";
    const outage = down.get(at);
    if (outage) return outage.clone();
    const data = maps.get(at);
    return data ? Response.json({ success: true, owner: `0x${dids[1].slice(-64)}`, data })
      : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
  });
  const outages = [new Response("unavailable", { status: 503 }),
    Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 })];
  const pair = { ...registration, listingAnchors: anchors.slice(0, 2) };
  const first = await indexRegistration(pair, undefined, offline);
  assert.deepEqual(first.listings.map(l => [l.version, l.status]), [[5, "superseded"], [6, "active"]]);
  for (const outage of outages) {
    down.set(anchors[1], outage);
    const held = await indexRegistration(pair, first, offline);
    assert.deepEqual(held.listings.map(l => [l.version, l.status]), [[5, "superseded"]]);
    down.clear();
  }
  down.set(anchors[1], outages[0]);
  assert.deepEqual((await indexRegistration(pair, undefined, offline)).listings.map(l => [l.version, l.status]), [[5, "active"]]);
  down.clear();

  const scope = signedScope(maps.get(anchors[2])!, "listing");
  scope.offering = { ...(scope.offering as Obj), title: "conflicting signed terms" };
  maps.set(anchors[2], { ...scope, signature: await sign(scope, "listing", 1) });
  const ambiguous = await indexRegistration(registration, undefined, offline);
  assert.ok(ambiguous.listings.length === 3 && ambiguous.listings.every(l => l.status === "superseded"));
  for (const at of anchors.slice(1)) {
    for (const outage of outages) {
      down.set(at, outage);
      const held = await indexRegistration(registration, ambiguous, offline);
      assert.equal(held.listings.length, 2);
      assert.ok(held.listings.every(l => l.status === "superseded"), JSON.stringify(held.listings.map(l => [l.version, l.status])));
      down.clear();
    }
  }
});
