// Isolate persistent state before importing the store.
import { isolatedDataDir } from "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test, { beforeEach, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { GET as exact } from "../app/api/dacs/listings/[listingId]/[version]/route.js";
import { GET as search } from "../app/api/dacs/listings/route.js";
import { activeCatalogListings } from "../src/catalog/discovery.js";
import { indexRegistration } from "../src/catalog/indexer.js";
import { PINNED_DEMOS_CHAIN_IDENTITY } from "../src/catalog/nodeDeployment.js";
import { reindexAll } from "../src/catalog/reindexCore.js";
import * as store from "../src/catalog/store.js";
import type { ArchivedListingVersion, Registration, SellerRecord } from "../src/catalog/types.js";
import { FixtureNode, kitListing, kitSeller, locator, type Artifact, type KitSeller } from "./fixtures/kit-listing.js";
import { nodeServingInTurn, onPinnedChain } from "./fixtures/pinned-node.js";
import { refuseCatalogWrites } from "./fixtures/refuse-catalog-writes.js";

// Existing synthetic contract fixtures only: no real wallet or network.
const seller = kitSeller(171);
const notAfter = 10_000;
const at = locator(15_300);
const offline = async (): Promise<never> => { throw new Error("identity unavailable"); };

beforeEach(() => {
  store.revertChainReadWindow();
  store.resetCatalogChain(PINNED_DEMOS_CHAIN_IDENTITY, true, 0);
});

function listing(owner = seller, version = 1, expiry = notAfter): Artifact {
  const original = kitListing(owner, { listingId: "expiry-service", listingVersion: version, notBefore: 2_000 });
  const { signature: _signature, ...scope } = original;
  scope.validity = { notBefore: 2_000, notAfter: expiry };
  return { ...scope, signature: { algorithm: "ed25519", signer: owner.claim,
    value: owner.sign("dacs-listing:v1:", contentHash(scope)) } };
}

function fixture(t: TestContext, raw = listing(), owner = seller): FixtureNode {
  const node = new FixtureNode();
  node.anchor(at, owner.owner, raw);
  t.mock.method(globalThis, "fetch", node.fetch);
  return node;
}

const registration = (owner = seller, anchors = [at]): Registration => ({
  primaryClaim: owner.claim, displayName: "Expiry seller", listingAnchors: anchors, ownerSigned: null,
});

async function publish(reg = registration(), prior?: SellerRecord): Promise<SellerRecord> {
  store.invalidateCatalogChain(PINNED_DEMOS_CHAIN_IDENTITY);
  store.openChainReadWindow();
  try {
    const record = await indexRegistration(reg, prior, offline);
    store.commitChainReadWindow(() => store.publishCatalogChain({
      catalogVersion: "1", generatedAt: Date.now(), sellers: [record],
    }, store.loadScanState(), PINNED_DEMOS_CHAIN_IDENTITY));
    return record;
  } finally {
    store.revertChainReadWindow();
  }
}

function get(owner: KitSeller = seller, version = 1) {
  return exact(new NextRequest("https://directory.example/api/dacs/listings/expiry-service/" + version +
    "?seller=" + encodeURIComponent(owner.claim)), {
    params: Promise.resolve({ listingId: "expiry-service", version: String(version) }),
  });
}

const query = { listingId: "expiry-service", version: "1", seller: seller.claim };
const archived = () => store.findArchivedListingVersion(query);
const emptyCatalog = () => ({ catalogVersion: "1" as const, generatedAt: Date.now(), sellers: [] });
const commit = () => store.commitChainReadWindow(() => store.publishCatalogChain(
  emptyCatalog(), store.loadScanState(), PINNED_DEMOS_CHAIN_IDENTITY));

function child(code: string): unknown {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: process.cwd(), env: { ...process.env, DACS_DIRECTORY_DATA: isolatedDataDir },
    encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

async function pointer(t: TestContext): Promise<ArchivedListingVersion> {
  fixture(t);
  await publish();
  const value = archived();
  assert.ok(value);
  return value;
}

test("expired explicit version remains fetchable before, at and after expiry without a new offer", async (t) => {
  let now = notAfter - 1;
  t.mock.method(Date, "now", () => now);
  const raw = listing();
  fixture(t, raw);
  let record = await publish();
  const pointer = { contentHash: record.listings[0].contentHash, anchor: record.listings[0].anchor };
  assert.equal(pointer.contentHash, contentHash(raw));
  assert.equal(pointer.anchor.locator, at);
  assert.equal(activeCatalogListings(store.loadCatalog()).length, 1);
  const before = await get();
  assert.equal(before.status, 200);
  assert.deepEqual(await before.json(), raw);
  now = notAfter;
  record = await publish(registration(), record);
  assert.equal(record.listings.length, 1, "expiry instant remains inclusive");
  assert.equal((await get()).status, 200);
  now++;
  await publish(registration(), record);
  assert.equal(activeCatalogListings(store.loadCatalog()).length, 0);
  const results = await search(new NextRequest("https://directory.example/api/dacs/listings"));
  assert.equal((await results.json()).total, 0);
  const after = await get();
  assert.equal(after.status, 200, "verified historical version survives the discovery expiry filter");
  assert.deepEqual(await after.json(), raw);
});

test("a cold first observation after expiry still archives verified history", async (t) => {
  t.mock.method(Date, "now", () => notAfter + 1);
  const raw = listing();
  fixture(t, raw);
  const record = await publish();
  assert.deepEqual(record.listings, []);
  assert.equal((await get()).status, 200);
  assert.deepEqual(await (await get()).json(), raw);
  assert.equal(archived()?.contentHash, contentHash(raw));
});

test("unconfirmed pointers stay invisible until catalog publication commits", async (t) => {
  t.mock.method(Date, "now", () => notAfter + 1);
  fixture(t);
  store.openChainReadWindow();
  await indexRegistration(registration(), undefined, offline);
  assert.equal(archived(), null);
  assert.equal((await get()).status, 404);
  assert.equal(child('import * as s from "./src/catalog/store.ts"; console.log(JSON.stringify(s.findArchivedListingVersion(' +
    JSON.stringify(query) + ')));'), null, "another process cannot read the provisional pointer");
  commit();
  assert.equal((await get()).status, 200);
});

test("ordinary catalog replacement and process restart retain the committed pointer", async (t) => {
  t.mock.method(Date, "now", () => notAfter + 1);
  const before = await pointer(t);
  store.saveCatalog(emptyCatalog());
  assert.equal(store.loadCatalog().sellers.length, 0);
  assert.deepEqual(archived(), before);
  const restarted = child('import * as s from "./src/catalog/store.ts"; console.log(JSON.stringify(s.findArchivedListingVersion(' +
    JSON.stringify(query) + ')));');
  assert.deepEqual(restarted, before);
  assert.equal((await get()).status, 200);
});

test("reverting a window discards new history and preserves the prior committed observation", async (t) => {
  let now = notAfter + 1;
  t.mock.method(Date, "now", () => now);
  const before = await pointer(t);
  now++;
  store.openChainReadWindow();
  store.retainVerifiedListingVersion({ ...before, catalogObservedAt: now });
  store.retainVerifiedListingVersion({ ...before, version: 2 });
  assert.deepEqual(archived(), before, "a staged refresh cannot replace the last confirmed observation");
  store.revertChainReadWindow();
  assert.deepEqual(archived(), before);
  assert.equal(store.findArchivedListingVersion({ ...query, version: "2" }), null);
});

test("a failed catalog save cannot publish pending archive entries", async (t) => {
  t.mock.method(Date, "now", () => notAfter + 1);
  fixture(t);
  store.openChainReadWindow();
  await indexRegistration(registration(), undefined, offline);
  const allow = refuseCatalogWrites(isolatedDataDir);
  try {
    assert.throws(commit, /catalog write failed/);
    assert.equal(archived(), null);
  } finally {
    allow();
    store.revertChainReadWindow();
  }
  assert.equal(archived(), null);
});

test("an interrupted process leaves no servable pointer and recovery removes its pending writes", async (t) => {
  t.mock.method(Date, "now", () => notAfter + 1);
  const before = await pointer(t);
  child('import * as s from "./src/catalog/store.ts"; s.openChainReadWindow(); s.retainVerifiedListingVersion(' +
    JSON.stringify({ ...before, version: 2 }) + ');');
  assert.equal(store.findArchivedListingVersion({ ...query, version: "2" }), null);
  child('import * as s from "./src/catalog/store.ts"; s.revertChainReadWindow(); s.openChainReadWindow(); ' +
    's.commitChainReadWindow(() => {}); console.log(JSON.stringify(s.findArchivedListingVersion(' +
    JSON.stringify({ ...query, version: "2" }) + ')));');
  assert.equal(store.findArchivedListingVersion({ ...query, version: "2" }), null);
  assert.deepEqual(archived(), before);
});

test("chain replacement and tip-regression reset both clear archived pointers", async (t) => {
  t.mock.method(Date, "now", () => notAfter + 1);
  fixture(t);
  for (const replacement of [false, true]) {
    await publish();
    assert.ok(archived());
    store.resetCatalogChain(PINNED_DEMOS_CHAIN_IDENTITY, replacement, 0);
    assert.equal(archived(), null);
    assert.equal((await get()).status, 404);
  }
});

test("lookup never imports a pointer from another admitted chain", async (t) => {
  t.mock.method(Date, "now", () => notAfter + 1);
  await pointer(t);
  store.invalidateCatalogChain("aa".repeat(32));
  assert.equal(archived(), null);
});

test("seller filters select the original verified bytes for colliding listing id and version", async (t) => {
  t.mock.method(Date, "now", () => notAfter + 1);
  const other = kitSeller(172);
  const original = listing();
  const otherRaw = listing(other);
  const node = fixture(t, original);
  const otherAt = locator(15_301);
  node.anchor(otherAt, other.owner, otherRaw);
  await publish();
  await publish(registration(other, [otherAt]));
  assert.deepEqual(await (await get()).json(), original);
  assert.deepEqual(await (await get(other)).json(), otherRaw);
  assert.equal((await get(kitSeller(173))).status, 404);
});

test("the archive preserves native-read and artifact-verification error paths", async (t) => {
  t.mock.method(Date, "now", () => notAfter + 1);
  const node = fixture(t);
  await publish();
  node.down = true;
  assert.equal((await get()).status, 503);
  node.down = false;
  node.anchor(at, seller.owner, listing(seller, 2));
  assert.equal((await get()).status, 502, "changed signed bytes cannot satisfy the old hash");
  node.anchor(at, seller.owner, { ...listing(), signature: {} });
  assert.equal((await get()).status, 502);
});

test("invalid signatures, wrong owners and future versions cannot create archive entries", async (t) => {
  t.mock.method(Date, "now", () => notAfter + 1);
  const raw = listing();
  const node = fixture(t, { ...raw, listingVersion: 2 });
  await publish();
  assert.equal(archived(), null);
  node.anchor(at, kitSeller(174).owner, raw);
  await publish();
  assert.equal(archived(), null);
  t.mock.method(Date, "now", () => 1_999);
  node.anchor(at, seller.owner, raw);
  await publish();
  assert.equal(archived(), null);
});

test("archive identity preserves claim parameters and escapes arbitrary listing id key characters", async (t) => {
  t.mock.method(Date, "now", () => notAfter + 1);
  const value = await pointer(t);
  const listingId = 'service%_["🔥\\\\';
  store.openChainReadWindow();
  store.retainVerifiedListingVersion({ ...value, listingId,
    seller: { ...value.seller, primaryClaim: seller.claim + "?label=history" } });
  commit();
  const result = store.findArchivedListingVersion({ ...query, listingId });
  assert.equal(result?.listingId, listingId);
  assert.equal(result?.seller.primaryClaim, seller.claim + "?label=history");
  assert.equal(store.findArchivedListingVersion({ ...query, listingId: listingId + "other" }), null);
});

test("an expired successor stays readable without reactivating the older offer", async (t) => {
  t.mock.method(Date, "now", () => notAfter + 1);
  const node = fixture(t, listing(seller, 1, notAfter + 100));
  const newerAt = locator(15_302);
  const newer = listing(seller, 2);
  node.anchor(newerAt, seller.owner, newer);
  const record = await publish(registration(seller, [at, newerAt]));
  assert.deepEqual(record.listings.map((entry) => [entry.version, entry.status]), [[1, "superseded"]]);
  assert.equal(activeCatalogListings(store.loadCatalog()).length, 0);
  assert.deepEqual(await (await get(seller, 2)).json(), newer);
});

test("a full reindex publishes history only when its final chain fence passes", async (t) => {
  t.mock.method(Date, "now", () => notAfter + 1);
  fixture(t);
  store.saveRegistrations([registration()]);
  await assert.rejects(reindexAll({ log: () => {}, resolveIdentities: offline,
    nodeDeployment: nodeServingInTurn(PINNED_DEMOS_CHAIN_IDENTITY, PINNED_DEMOS_CHAIN_IDENTITY, "aa".repeat(32)) }),
  /catalog not updated: the served chain changed/);
  assert.equal(archived(), null);
  await reindexAll({ log: () => {}, resolveIdentities: offline, nodeDeployment: onPinnedChain });
  assert.equal(store.loadCatalog().sellers[0].listings.length, 0);
  assert.equal((await get()).status, 200);
});
