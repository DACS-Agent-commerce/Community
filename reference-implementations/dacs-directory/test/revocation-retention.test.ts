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

test("completed publication prunes aged rejected and unmatched candidates but keeps pending live and held candidates", (t) => {
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
  assert.deepEqual(rows(absent), [], "removed, expired and never-listed hashes are unmatched");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM revocation_candidate_retries WHERE listing_hash=?").get(absent) as { n: number }).n, 0);
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
  now += week - 1;
  store.admitRevocationCandidates(hash, [{ locator: at, contentHash: "changed" }]);
  store.publishCatalogChain({ catalogVersion: "1", generatedAt: now, sellers: [] }, store.loadScanState(), "retention-chain", true);
  assert.deepEqual(rows(hash), [], "unchanged observations cannot keep unmatched rows forever");
});

test("incomplete discovery and failed publication cannot discard aged candidates", (t) => {
  let now = 1_820_000_000_000;
  t.mock.method(Date, "now", () => now);
  const hash = "5".repeat(64);
  store.admitRevocationCandidates(hash, [{ locator: locator(20) }]);
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
