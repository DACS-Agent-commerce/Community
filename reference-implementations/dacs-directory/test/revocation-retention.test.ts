import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { Catalog } from "../src/catalog/types.js";
import { contentHash } from "../src/catalog/canonical.js";

const directory = mkdtempSync(join(tmpdir(), "dacs-revocation-retention-"));
process.env.DACS_DIRECTORY_DATA = directory;
const store = await import("../src/catalog/store.js");
const db = new Database(join(directory, "directory.sqlite"));
test.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
const week = 7 * 24 * 60 * 60 * 1000;
const locator = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;
const rows = (hash: string) => db.prepare("SELECT locator, state FROM revocation_candidates WHERE listing_hash=? ORDER BY locator").all(hash);
const catalog = (live: string, held: string): Catalog => ({ catalogVersion: "1", generatedAt: 1, sellers: [{
  primaryClaim: `did:demos:agent:${"a".repeat(64)}`, displayName: "retention fixture", cci: [], deals: [],
  listings: [{ listingId: "live", version: 1, contentHash: live, status: "active", catalogObservedAt: 1,
    anchor: { kind: "storage-program", locator: locator(91) }, seller: { primaryClaim: `did:demos:agent:${"a".repeat(64)}`, displayName: "retention fixture" },
    offering: { title: "retention fixture", category: "test", tags: [] }, pricing: {} }],
  heldListingVersions: [{ locator: locator(90), listingId: "held", version: 1, contentHash: held }],
  reputation: { completed: 0, totalAgreements: 0, completionRate: null }, registeredAt: 1, lastIndexedAt: 1,
}] });

test("completed publication prunes only aged rejected candidates and keeps all pending candidates", (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const live = "1".repeat(64), held = "2".repeat(64), absent = "3".repeat(64);
  store.admitRevocationCandidates(live, [{ locator: locator(1), contentHash: "old" }, { locator: locator(2) }]);
  store.recordRevocationProgress(live, { unread: [], rejected: [locator(1)] });
  store.admitRevocationCandidates(held, [{ locator: locator(3) }]);
  store.admitRevocationCandidates(absent, [{ locator: locator(4) }]);
  store.recordRevocationProgress(absent, { unread: [locator(4)], rejected: [] });
  now += week - 1;
  store.publishCatalogChain(catalog(live, held), store.loadScanState(), "retention-chain", true);
  assert.equal(rows(live).length, 2, "age floor retains a recent rejection");
  assert.equal(rows(absent).length, 1, "age floor retains an unmatched candidate");
  now++;
  store.publishCatalogChain(catalog(live, held), store.loadScanState(), "retention-chain", true);
  assert.deepEqual(rows(live), [{ locator: locator(2), state: "pending" }]);
  assert.deepEqual(rows(held), [{ locator: locator(3), state: "pending" }]);
  assert.deepEqual(rows(absent), [{ locator: locator(4), state: "pending" }], "unmatched pending evidence survives");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM revocation_candidate_retries WHERE listing_hash=?").get(absent) as { n: number }).n, 1, "pending retry metadata survives with its candidate");
});

test("unchanged observations do not renew age, but changed values reopen rejection with a fresh window", (t) => {
  let now = 1_810_000_000_000;
  t.mock.method(Date, "now", () => now);
  const hash = "4".repeat(64), at = locator(10);
  store.admitRevocationCandidates(hash, [{ locator: at, contentHash: "old" }]);
  store.recordRevocationProgress(hash, { unread: [], rejected: [at] });
  now += week - 1;
  store.admitRevocationCandidates(hash, [{ locator: at, contentHash: "old" }]);
  assert.deepEqual(store.nextRevocationCandidates(hash, null, 16), []);
  store.admitRevocationCandidates(hash, [{ locator: at, contentHash: "changed" }]);
  assert.deepEqual(store.nextRevocationCandidates(hash, null, 16), [at]);
  now++;
  store.publishCatalogChain({ catalogVersion: "1", generatedAt: now, sellers: [] }, store.loadScanState(), "retention-chain", true);
  assert.equal(rows(hash).length, 1, "a newly changed value gets a full week");
  store.recordRevocationProgress(hash, { unread: [], rejected: [at] });
  now += week - 1;
  store.admitRevocationCandidates(hash, [{ locator: at, contentHash: "changed" }]);
  store.publishCatalogChain({ catalogVersion: "1", generatedAt: now, sellers: [] }, store.loadScanState(), "retention-chain", true);
  assert.deepEqual(rows(hash), [], "unchanged observations cannot keep rejected rows forever");
});

test("incomplete discovery and failed publication cannot discard aged candidates", (t) => {
  let now = 1_820_000_000_000;
  t.mock.method(Date, "now", () => now);
  const hash = "5".repeat(64);
  store.admitRevocationCandidates(hash, [{ locator: locator(20) }]);
  store.recordRevocationProgress(hash, { unread: [], rejected: [locator(20)] });
  now += week;
  const empty: Catalog = { catalogVersion: "1", generatedAt: now, sellers: [] };
  store.publishCatalogChain(empty, store.loadScanState(), "retention-chain");
  assert.equal(rows(hash).length, 1, "single-registration publication does not opt into full discovery");
  store.publishCatalogChain(empty, store.loadScanState(), "retention-chain", false);
  assert.equal(rows(hash).length, 1);
  db.exec("CREATE TRIGGER fail_retention_publish BEFORE UPDATE ON kv_state WHEN new.key='catalog' BEGIN SELECT RAISE(ABORT,'test publication failure'); END");
  try {
    assert.throws(() => store.publishCatalogChain(empty, store.loadScanState(), "retention-chain", true), /test publication failure/);
    assert.equal(rows(hash).length, 1, "cleanup rolls back with publication");
  } finally { db.exec("DROP TRIGGER fail_retention_publish"); }
  store.publishCatalogChain(empty, store.loadScanState(), "retention-chain", true);
  assert.deepEqual(rows(hash), []);
});

test("an aged pending owner marker survives publication when it withholds a newly read live Listing", async (t) => {
  let now = 1_830_000_000_000;
  t.mock.method(Date, "now", () => now);
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const claim = `did:demos:agent:${publicKey}`, owner = `0x${publicKey}`;
  const signature = (message: string) => sign(null, Buffer.from(message), keys.privateKey).toString("base64url");
  const identity = { bundleVersion: "1", presentedBy: claim, presentedAt: 1, claims: [{ ref: claim }] };
  const scope = { dacsVersion: "1", listingVersion: 1, listingId: "pending-retention",
    seller: { displayName: "seller", identity: { ...identity, presentation: { kind: "per-claim",
      signatures: [{ ref: claim, signature: signature(`dacs-bundle-presentation:v1:${contentHash(identity)}`) }] } } },
    offering: { title: "retention", description: "retention", category: "test", tags: [],
      deliverable: { kind: "storage-program", accessModel: "public" } },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "deliver-storage-program" }],
    pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } }, terms: {}, validity: { notBefore: 1 } };
  const hash = contentHash(scope), anchor = locator(31), marker = locator(32);
  const listing = { ...scope, signature: { algorithm: "ed25519", signer: claim, value: signature(`dacs-listing:v1:${hash}`) } };
  store.admitRevocationCandidates(hash, [{ locator: marker, owner, contentHash: "unavailable-marker" }]);
  now += week;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    if (new URL(String(input)).pathname.endsWith(anchor)) return Response.json({ success: true, owner, data: listing });
    return new Response("unavailable", { status: 503 });
  });
  const { indexRegistration } = await import("../src/catalog/indexer.js");
  const seller = await indexRegistration({ primaryClaim: claim, displayName: "seller", listingAnchors: [anchor] },
    undefined, async () => { throw new Error("offline"); });
  assert.deepEqual(seller.listings, [], "an unresolved owner marker must withhold the Listing");
  store.publishCatalogChain({ catalogVersion: "1", generatedAt: now, sellers: [seller] }, store.loadScanState(), "retention-chain", true);
  assert.equal(rows(hash).length, 1, "publication must not prune the pending marker of a live withheld Listing");
  assert.equal(store.hasPendingRevocationCandidates(hash), true);
});


test("reindex preserves failed seller pending markers while pruning successful seller aged rejected candidates", async (t) => {
  let now = 1_840_000_000_000;
  t.mock.method(Date, "now", () => now);
  const { PINNED_DEMOS_CHAIN_IDENTITY } = await import("../src/catalog/nodeDeployment.js");
  const { onPinnedChain } = await import("./fixtures/pinned-node.js");
  const { reindexAll } = await import("../src/catalog/reindexCore.js");
  const failedHash = "6".repeat(64), staleHash = "7".repeat(64), unknownHash = "8".repeat(64);
  const failed = catalog(failedHash, "9".repeat(64)).sellers[0];
  const successful = catalog(staleHash, "a".repeat(64)).sellers[0];
  successful.primaryClaim = `did:demos:agent:${"b".repeat(64)}`;
  successful.heldListingVersions = [];
  // Simulate a corrupt per-seller cached field: indexRegistration throws while
  // preserving an unread anchor. The reindex caller must isolate this failure.
  failed.heldListingVersions = {} as typeof failed.heldListingVersions;
  store.publishCatalogChain({ catalogVersion: "1", generatedAt: now, sellers: [failed, successful] },
    { ...store.loadScanState(), listings: {}, deals: {}, programs: {}, revocations: {}, verifiedRevocations: {} },
    PINNED_DEMOS_CHAIN_IDENTITY);
  store.saveRegistrations([
    { primaryClaim: failed.primaryClaim, displayName: "failed", listingAnchors: [failed.listings[0].anchor.locator] },
    { primaryClaim: successful.primaryClaim, displayName: "successful", listingAnchors: [] },
  ]);
  for (const [hash, n] of [[failedHash, 41], [staleHash, 42], [unknownHash, 43]] as const) {
    store.admitRevocationCandidates(hash, [{ locator: locator(n), contentHash: "unchanged" }]);
  }
  store.recordRevocationProgress(staleHash, { unread: [], rejected: [locator(42)] });
  now += week;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    if (init?.body) return Response.json({ result: 200, response: [] });
    return new Response("unavailable", { status: 503 });
  });
  const logs: string[] = [];
  const summary = await reindexAll({ log: (line) => logs.push(line), nodeDeployment: onPinnedChain,
    resolveIdentities: async () => [], crawlWellKnown: async () => ({ agents: [], errors: [] }) });
  assert.equal(summary.sellers, 1);
  assert.ok(logs.some((line) => line.includes("seller indexing failed")), "the production caller caught the indexing exception");
  assert.deepEqual(store.loadStoredCatalog().sellers.map((seller) => seller.primaryClaim), [successful.primaryClaim]);
  assert.equal(rows(failedHash).length, 1, "an omitted seller's pending evidence survives");
  assert.deepEqual(rows(staleHash), [], "a successfully indexed seller's aged rejected candidate is pruned");
  assert.equal(rows(unknownHash).length, 1, "partial indexing cannot attribute an unknown hash safely");
});


for (const failedFirst of [false, true]) {
  test(`duplicate registrations retain pending evidence when ${failedFirst ? "failed" : "successful"} registration runs first`, async (t) => {
    let now = 1_850_000_000_000;
    t.mock.method(Date, "now", () => now);
    const { PINNED_DEMOS_CHAIN_IDENTITY } = await import("../src/catalog/nodeDeployment.js");
    const { onPinnedChain } = await import("./fixtures/pinned-node.js");
    const { reindexAll } = await import("../src/catalog/reindexCore.js");
    const failedHash = (failedFirst ? "b" : "c").repeat(64);
    const staleHash = (failedFirst ? "d" : "e").repeat(64);
    const failed = catalog(failedHash, "f".repeat(64)).sellers[0];
    failed.primaryClaim = `did:demos:agent:${"c".repeat(64)}`;
    failed.heldListingVersions = [];
    const unreadAnchor = failed.listings[0].anchor.locator;
    // A corrupt cached anchor throws only when this registration reads an
    // unavailable anchor. The duplicate with no anchors still indexes normally.
    failed.listings[0].anchor = null as unknown as (typeof failed.listings)[number]["anchor"];
    const successful = catalog(staleHash, "f".repeat(64)).sellers[0];
    successful.primaryClaim = `did:demos:agent:${"b".repeat(64)}`;
    successful.heldListingVersions = [];
    store.publishCatalogChain({ catalogVersion: "1", generatedAt: now, sellers: [failed, successful] },
      { ...store.loadScanState(), listings: {}, deals: {}, programs: {}, revocations: {}, verifiedRevocations: {} },
      PINNED_DEMOS_CHAIN_IDENTITY);
    const duplicates = [
      { primaryClaim: failed.primaryClaim, displayName: "successful duplicate", listingAnchors: [] },
      { primaryClaim: failed.primaryClaim, displayName: "failed duplicate", listingAnchors: [unreadAnchor] },
    ];
    store.saveRegistrations([
      ...(failedFirst ? duplicates.toReversed() : duplicates),
      { primaryClaim: successful.primaryClaim, displayName: "successful seller", listingAnchors: [] },
    ]);
    store.admitRevocationCandidates(failedHash, [{ locator: locator(51), contentHash: "unchanged" }]);
    store.admitRevocationCandidates(staleHash, [{ locator: locator(52), contentHash: "unchanged" }]);
    store.recordRevocationProgress(staleHash, { unread: [], rejected: [locator(52)] });
    now += week;
    t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
      if (init?.body) return Response.json({ result: 200, response: [] });
      return new Response("unavailable", { status: 503 });
    });
    const logs: string[] = [];
    const summary = await reindexAll({ log: (line) => logs.push(line), nodeDeployment: onPinnedChain,
      resolveIdentities: async () => [], crawlWellKnown: async () => ({ agents: [], errors: [] }) });
    assert.equal(summary.sellers, 2, "one duplicate and the unrelated seller indexed successfully");
    assert.equal(logs.filter((line) => line.includes("seller indexing failed")).length, 1,
      "exactly one duplicate reached the production exception handler");
    assert.equal(rows(failedHash).length, 1, "any failed registration protects this seller's pending marker");
    assert.deepEqual(rows(staleHash), [], "the unrelated successful seller can still prune aged rejected evidence");
  });
}


for (const anchoredFirst of [false, true]) {
  test(`malformed cached held versions isolate duplicate registrations with no anchors (${anchoredFirst ? "anchored first" : "empty first"})`, async (t) => {
    let now = 1_860_000_000_000;
    t.mock.method(Date, "now", () => now);
    const { PINNED_DEMOS_CHAIN_IDENTITY } = await import("../src/catalog/nodeDeployment.js");
    const { onPinnedChain } = await import("./fixtures/pinned-node.js");
    const { reindexAll } = await import("../src/catalog/reindexCore.js");
    const failedHash = (anchoredFirst ? "16" : "17").repeat(32);
    const staleHash = (anchoredFirst ? "12" : "13").repeat(32);
    const failed = catalog(failedHash, "14".repeat(32)).sellers[0];
    failed.primaryClaim = `did:demos:agent:${"d".repeat(64)}`;
    failed.heldListingVersions = {} as typeof failed.heldListingVersions;
    const successful = catalog(staleHash, "15".repeat(32)).sellers[0];
    successful.primaryClaim = `did:demos:agent:${"e".repeat(64)}`;
    successful.heldListingVersions = [];
    store.publishCatalogChain({ catalogVersion: "1", generatedAt: now, sellers: [failed, successful] },
      { ...store.loadScanState(), listings: {}, deals: {}, programs: {}, revocations: {}, verifiedRevocations: {} },
      PINNED_DEMOS_CHAIN_IDENTITY);
    const duplicates = [
      { primaryClaim: failed.primaryClaim, displayName: "empty duplicate", listingAnchors: [] },
      { primaryClaim: failed.primaryClaim, displayName: "anchored duplicate", listingAnchors: [failed.listings[0].anchor.locator] },
    ];
    store.saveRegistrations([
      ...(anchoredFirst ? duplicates.toReversed() : duplicates),
      { primaryClaim: successful.primaryClaim, displayName: "unrelated seller", listingAnchors: [] },
    ]);
    store.admitRevocationCandidates(failedHash, [{ locator: locator(61), contentHash: "unchanged" }]);
    store.admitRevocationCandidates(staleHash, [{ locator: locator(62), contentHash: "unchanged" }]);
    store.recordRevocationProgress(staleHash, { unread: [], rejected: [locator(62)] });
    now += week;
    t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
      if (init?.body) return Response.json({ result: 200, response: [] });
      return new Response("unavailable", { status: 503 });
    });
    const logs: string[] = [];
    const summary = await reindexAll({ log: (line) => logs.push(line), nodeDeployment: onPinnedChain,
      resolveIdentities: async () => [], crawlWellKnown: async () => ({ agents: [], errors: [] }) });
    assert.equal(summary.sellers, 1, "the run completes with the unrelated seller");
    assert.equal(logs.filter((line) => line.includes("seller indexing failed")).length, 2,
      "both the anchored and empty duplicate use the per-seller failure handler");
    assert.deepEqual(store.loadStoredCatalog().sellers.map((seller) => seller.primaryClaim), [successful.primaryClaim]);
    assert.equal(rows(failedHash).length, 1, "the failed seller's aged pending marker survives");
    assert.deepEqual(rows(staleHash), [], "the unrelated successful seller still prunes aged rejected evidence");
  });
}


test("reindex preserves failed and unknown seller aged rejected markers while pruning successful seller aged rejected candidates", async (t) => {
  let now = 1_840_000_000_000;
  t.mock.method(Date, "now", () => now);
  const { PINNED_DEMOS_CHAIN_IDENTITY } = await import("../src/catalog/nodeDeployment.js");
  const { onPinnedChain } = await import("./fixtures/pinned-node.js");
  const { reindexAll } = await import("../src/catalog/reindexCore.js");
  const failedHash = "61".repeat(32), staleHash = "71".repeat(32), unknownHash = "81".repeat(32);
  const failed = catalog(failedHash, "9".repeat(64)).sellers[0];
  const successful = catalog(staleHash, "a".repeat(64)).sellers[0];
  successful.primaryClaim = `did:demos:agent:${"b".repeat(64)}`;
  successful.heldListingVersions = [];
  // Simulate a corrupt per-seller cached field: indexRegistration throws while
  // preserving an unread anchor. The reindex caller must isolate this failure.
  failed.heldListingVersions = {} as typeof failed.heldListingVersions;
  store.publishCatalogChain({ catalogVersion: "1", generatedAt: now, sellers: [failed, successful] },
    { ...store.loadScanState(), listings: {}, deals: {}, programs: {}, revocations: {}, verifiedRevocations: {} },
    PINNED_DEMOS_CHAIN_IDENTITY);
  store.saveRegistrations([
    { primaryClaim: failed.primaryClaim, displayName: "failed", listingAnchors: [failed.listings[0].anchor.locator] },
    { primaryClaim: successful.primaryClaim, displayName: "successful", listingAnchors: [] },
  ]);
  for (const [hash, n] of [[failedHash, 41], [staleHash, 42], [unknownHash, 43]] as const) {
    store.admitRevocationCandidates(hash, [{ locator: locator(n), contentHash: "unchanged" }]);
  }
  store.recordRevocationProgress(failedHash, { unread: [], rejected: [locator(41)] });
  store.recordRevocationProgress(unknownHash, { unread: [], rejected: [locator(43)] });
  store.recordRevocationProgress(staleHash, { unread: [], rejected: [locator(42)] });
  now += week;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    if (init?.body) return Response.json({ result: 200, response: [] });
    return new Response("unavailable", { status: 503 });
  });
  const logs: string[] = [];
  const summary = await reindexAll({ log: (line) => logs.push(line), nodeDeployment: onPinnedChain,
    resolveIdentities: async () => [], crawlWellKnown: async () => ({ agents: [], errors: [] }) });
  assert.equal(summary.sellers, 1);
  assert.ok(logs.some((line) => line.includes("seller indexing failed")), "the production caller caught the indexing exception");
  assert.deepEqual(store.loadStoredCatalog().sellers.map((seller) => seller.primaryClaim), [successful.primaryClaim]);
  assert.deepEqual(rows(failedHash), [{ locator: locator(41), state: "rejected" }], "an omitted seller's aged rejected evidence survives");
  assert.deepEqual(rows(staleHash), [], "a successfully indexed seller's aged rejected candidate is pruned");
  assert.deepEqual(rows(unknownHash), [{ locator: locator(43), state: "rejected" }], "partial indexing cannot attribute an unknown hash safely");
});


for (const failedFirst of [false, true]) {
  test(`duplicate registrations retain aged rejected evidence when ${failedFirst ? "failed" : "successful"} registration runs first`, async (t) => {
    let now = 1_850_000_000_000;
    t.mock.method(Date, "now", () => now);
    const { PINNED_DEMOS_CHAIN_IDENTITY } = await import("../src/catalog/nodeDeployment.js");
    const { onPinnedChain } = await import("./fixtures/pinned-node.js");
    const { reindexAll } = await import("../src/catalog/reindexCore.js");
    const failedHash = (failedFirst ? "b1" : "c1").repeat(32);
    const staleHash = (failedFirst ? "d1" : "e1").repeat(32);
    const failed = catalog(failedHash, "f".repeat(64)).sellers[0];
    failed.primaryClaim = `did:demos:agent:${"c".repeat(64)}`;
    failed.heldListingVersions = [];
    const unreadAnchor = failed.listings[0].anchor.locator;
    // A corrupt cached anchor throws only when this registration reads an
    // unavailable anchor. The duplicate with no anchors still indexes normally.
    failed.listings[0].anchor = null as unknown as (typeof failed.listings)[number]["anchor"];
    const successful = catalog(staleHash, "f".repeat(64)).sellers[0];
    successful.primaryClaim = `did:demos:agent:${"b".repeat(64)}`;
    successful.heldListingVersions = [];
    store.publishCatalogChain({ catalogVersion: "1", generatedAt: now, sellers: [failed, successful] },
      { ...store.loadScanState(), listings: {}, deals: {}, programs: {}, revocations: {}, verifiedRevocations: {} },
      PINNED_DEMOS_CHAIN_IDENTITY);
    const duplicates = [
      { primaryClaim: failed.primaryClaim, displayName: "successful duplicate", listingAnchors: [] },
      { primaryClaim: failed.primaryClaim, displayName: "failed duplicate", listingAnchors: [unreadAnchor] },
    ];
    store.saveRegistrations([
      ...(failedFirst ? duplicates.toReversed() : duplicates),
      { primaryClaim: successful.primaryClaim, displayName: "successful seller", listingAnchors: [] },
    ]);
    store.admitRevocationCandidates(failedHash, [{ locator: locator(51), contentHash: "unchanged" }]);
    store.admitRevocationCandidates(staleHash, [{ locator: locator(52), contentHash: "unchanged" }]);
    store.recordRevocationProgress(failedHash, { unread: [], rejected: [locator(51)] });
    store.recordRevocationProgress(staleHash, { unread: [], rejected: [locator(52)] });
    now += week;
    t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
      if (init?.body) return Response.json({ result: 200, response: [] });
      return new Response("unavailable", { status: 503 });
    });
    const logs: string[] = [];
    const summary = await reindexAll({ log: (line) => logs.push(line), nodeDeployment: onPinnedChain,
      resolveIdentities: async () => [], crawlWellKnown: async () => ({ agents: [], errors: [] }) });
    assert.equal(summary.sellers, 2, "one duplicate and the unrelated seller indexed successfully");
    assert.equal(logs.filter((line) => line.includes("seller indexing failed")).length, 1,
      "exactly one duplicate reached the production exception handler");
    assert.deepEqual(rows(failedHash), [{ locator: locator(51), state: "rejected" }], "any failed registration protects this seller's aged rejected marker");
    assert.deepEqual(rows(staleHash), [], "the unrelated successful seller can still prune aged rejected evidence");
  });
}

