import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";

const directory = mkdtempSync(join(tmpdir(), "dacs-revocation-read-upgrade-"));
process.env.DACS_DIRECTORY_DATA = directory;
const seed = Buffer.alloc(32, 91);
const claim = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const owner = `0x${claim.slice(-64)}`;
const sign = (message: string, encoding: BufferEncoding = "base64url") =>
  Buffer.from(ed25519Sign(Buffer.from(message), privateKeyFromSeed(seed))).toString(encoding);
const identity = { bundleVersion: "1", presentedBy: claim, presentedAt: 1, claims: [{ ref: claim }] };
const scope = {
  dacsVersion: "1", listingVersion: 1, listingId: "read-upgrade", seller: { displayName: "seller", identity: {
    ...identity, presentation: { kind: "per-claim", signatures: [{ ref: claim,
      signature: sign(`dacs-bundle-presentation:v1:${contentHash(identity)}`, "hex") }] },
  } },
  offering: { title: "read-upgrade", description: "read-upgrade", category: "test", tags: [], deliverable: { kind: "storage-program" } },
  buyerRequirement: { requirementVersion: "1", required: [] },
  pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "deliver-storage-program" }],
  pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } }, terms: {}, validity: { notBefore: 1 },
};
const hash = contentHash(scope);
const listing = { ...scope, signature: { algorithm: "ed25519", signer: claim, value: sign(`dacs-listing:v1:${hash}`) } };
const at = (digit: string) => `stor-${digit.repeat(40)}`;
const [listingAt, ownerMarker, otherMarker, laterMarker] = ["1", "2", "3", "4"].map(at);
const otherHash = "b".repeat(64), laterHash = "f".repeat(64);
const seeded = new Database(join(directory, "directory.sqlite"));
// A database the version 1 read migration already upgraded. Its rejections include
// candidates whose reply data was not an object, which earlier releases settled as read.
// The owner marker's owner is stored in another spelling of the seller's own key.
seeded.exec(`
  CREATE TABLE kv_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
  INSERT INTO kv_state VALUES ('schema-version','1',0), ('sr2-anchor-schema-version','2',0),
    ('listing-admission-schema-version','1',0), ('revocation-read-schema-version','1',0);
  CREATE TABLE revocation_candidates (
    listing_hash TEXT NOT NULL, locator TEXT NOT NULL, owner TEXT, content_hash TEXT,
    seq INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(listing_hash,locator)
  );
`);
const insert = seeded.prepare("INSERT INTO revocation_candidates VALUES (?,?,?,?,?,?)");
insert.run(hash, ownerMarker, `did:demos:agent:${claim.slice(-64).toUpperCase()}`, "d".repeat(64), 1, "rejected");
insert.run(otherHash, otherMarker, `0x${"e".repeat(64)}`, "e".repeat(64), 2, "rejected");
insert.run(laterHash, laterMarker, owner, null, 3, "pending");
seeded.prepare("INSERT INTO kv_state VALUES ('catalog',?,0)").run(JSON.stringify({
  catalogVersion: "1", generatedAt: 100, sellers: [{ primaryClaim: claim, deals: [], listings: [
    { listingId: "read-upgrade", contentHash: hash, status: "active" },
    { listingId: "third-party", contentHash: otherHash, status: "active" },
    { listingId: "unaffected", contentHash: "a".repeat(64), status: "active" },
  ] }],
}));
seeded.close();
const store = await import("../src/catalog/store.js");
const { indexRegistration } = await import("../src/catalog/indexer.js");
test.after(() => rmSync(directory, { recursive: true, force: true }));

test("upgrade from read version 1 requeues earlier rejections and withholds only rows the owner's own candidate holds", () => {
  assert.deepEqual(store.nextRevocationCandidates(hash, owner, 16), [ownerMarker]);
  assert.equal(store.hasPendingOwnerRevocationCandidate(hash, owner), true);
  assert.deepEqual(store.nextRevocationCandidates(otherHash, null, 16), [otherMarker], "third-party rejections are reread too");
  assert.deepEqual(store.loadCatalog().sellers[0].listings.map((entry) => entry.listingId), ["third-party", "unaffected"]);
});

const victimHash = "c".repeat(64), fixtureHash = "9".repeat(64);
const thirdParty = `0x${"e".repeat(64)}`;
interface SeededCandidate {
  hash: string; owner: string | null;
  /** Stored state; `legacy` leaves it in an earlier release's scan-state queue with an `artifacts` owner row. */
  state?: "rejected" | "pending" | "legacy";
  /** A retry row whose backoff ends this far after the start. */
  retryIn?: number;
}
/**
 * Seed a database at `readVersion` (none: a database from before read versions) whose seller has an active
 * `victim`, an active `fixture` row and a revoked `withdrawn` row, plus these candidates (rejected unless
 * stated); start the store in a fresh process twice and return the active rows, which candidates are
 * pending, and whether the live hold rule holds `victim` for the seller, as the second start sees them.
 */
function startUpgraded(candidates: SeededCandidate[], { readVersion = 1 as number | null, sellerClaim = claim } = {}):
  { ids: string[]; pending: boolean[]; ownerHeld: boolean } {
  const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-revocation-read-owner-"));
  const db = new Database(join(dataDirectory, "directory.sqlite"));
  db.exec(`CREATE TABLE kv_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE revocation_candidates (listing_hash TEXT NOT NULL, locator TEXT NOT NULL, owner TEXT, content_hash TEXT,
      seq INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(listing_hash,locator));
    CREATE TABLE revocation_candidate_retries (listing_hash TEXT NOT NULL, locator TEXT NOT NULL, attempts INTEGER NOT NULL,
      retry_after INTEGER NOT NULL, PRIMARY KEY(listing_hash, locator));
    CREATE TABLE artifacts (locator TEXT PRIMARY KEY, kind TEXT NOT NULL, profile TEXT NOT NULL, owner TEXT, content_hash TEXT,
      observed_at INTEGER NOT NULL, anchor_time INTEGER, status TEXT NOT NULL DEFAULT 'observed', error_code TEXT,
      error_message TEXT, retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at INTEGER, data_json TEXT);`);
  const versions = { "schema-version": 1, "sr2-anchor-schema-version": 2, "listing-admission-schema-version": 1,
    ...(readVersion === null ? {} : { "revocation-read-schema-version": readVersion }) };
  for (const [key, value] of Object.entries(versions)) db.prepare("INSERT INTO kv_state VALUES (?,?,0)").run(key, JSON.stringify(value));
  const legacyQueue: Record<string, string[]> = {};
  candidates.forEach(({ hash: listingHash, owner: storedOwner, state = "rejected", retryIn }, index) => {
    const locator = at((5 + index).toString(16));
    if (state === "legacy") {
      (legacyQueue[listingHash] ??= []).push(locator);
      db.prepare("INSERT INTO artifacts(locator,kind,profile,owner,content_hash,observed_at) VALUES (?,'listing-revocation','dacs-v1',?,?,0)")
        .run(locator, storedOwner, "d".repeat(64));
      return;
    }
    db.prepare("INSERT INTO revocation_candidates VALUES (?,?,?,?,?,?)").run(listingHash, locator, storedOwner, "d".repeat(64), index + 1, state);
    if (retryIn !== undefined) db.prepare("INSERT INTO revocation_candidate_retries VALUES (?,?,1,?)").run(listingHash, locator, Date.now() + retryIn);
  });
  db.prepare("INSERT INTO kv_state VALUES ('scan-state',?,0)").run(JSON.stringify({ lastSeenTxId: 0, listings: {}, deals: {}, revocations: legacyQueue }));
  db.prepare("INSERT INTO kv_state VALUES ('catalog',?,0)").run(JSON.stringify({ catalogVersion: "1", generatedAt: 100, sellers: [{
    primaryClaim: sellerClaim, deals: [], listings: [
      { listingId: "victim", contentHash: victimHash, status: "active", anchor: { kind: "storage-program", locator: listingAt } },
      { listingId: "fixture", contentHash: fixtureHash, status: "active", anchor: { kind: "fixture", locator: "fixture:desk" } },
      { listingId: "withdrawn", contentHash: victimHash, status: "revoked", anchor: { kind: "storage-program", locator: at("9") } },
    ] }] }));
  db.close();
  const moduleUrl = new URL("../src/catalog/store.js", import.meta.url).href;
  const code = `const s = await import(${JSON.stringify(moduleUrl)});
    console.log(JSON.stringify({ ids: s.loadCatalog().sellers[0].listings.map((l) => l.listingId),
      pending: ${JSON.stringify(candidates.map((candidate) => candidate.hash))}.map((h) => s.hasPendingRevocationCandidates(h)),
      ownerHeld: s.hasPendingOwnerRevocationCandidate(${JSON.stringify(victimHash)}, ${JSON.stringify(sellerClaim)}) }));`;
  try {
    let started = { ids: [] as string[], pending: [] as boolean[], ownerHeld: false };
    for (let restart = 0; restart < 2; restart++) {
      const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code],
        { encoding: "utf8", env: { ...process.env, DACS_DIRECTORY_DATA: dataDirectory } });
      assert.equal(child.status, 0, child.stderr);
      started = JSON.parse(child.stdout);
    }
    return started;
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
}

const upgradeCases: Array<[string, Parameters<typeof startUpgraded>, string[]]> = [
  ["a third party's rejected candidate on the seller's own hash", [[{ hash: victimHash, owner: thirdParty }]], ["victim", "fixture", "withdrawn"]],
  ["the same candidate in a database from before read versions", [[{ hash: victimHash, owner: thirdParty }], { readVersion: null }],
    ["victim", "fixture", "withdrawn"]],
  ["a rejected candidate whose owner was never known", [[{ hash: victimHash, owner: null }]], ["victim", "fixture", "withdrawn"]],
  ["a third party's rejected candidate on a fixture row's hash", [[{ hash: fixtureHash, owner: thirdParty }]], ["victim", "fixture", "withdrawn"]],
  ["the seller's own rejected candidate", [[{ hash: victimHash, owner }]], ["fixture", "withdrawn"]],
  ["the seller's own candidate stored as an uppercase claim", [[{ hash: victimHash, owner: `did:demos:agent:${claim.slice(-64).toUpperCase()}` }]],
    ["fixture", "withdrawn"]],
  ["the seller's own and a third party's candidate on one hash", [[{ hash: victimHash, owner: thirdParty }, { hash: victimHash, owner }]],
    ["fixture", "withdrawn"]],
  ["any rejected candidate when the seller claim names no storage owner", [[{ hash: victimHash, owner: thirdParty }], { sellerClaim: "did:demos:agent:short" }],
    ["fixture", "withdrawn"]],
  ["the seller's own candidate already pending", [[{ hash: victimHash, owner, state: "pending" }]], ["fixture", "withdrawn"]],
  ["the seller's own pending candidate waiting out its retry backoff", [[{ hash: victimHash, owner, state: "pending", retryIn: 3_600_000 }]],
    ["fixture", "withdrawn"]],
  ["the seller's own pending candidate in a database from before read versions", [[{ hash: victimHash, owner, state: "pending" }],
    { readVersion: null }], ["fixture", "withdrawn"]],
  ["a third party's pending candidate", [[{ hash: victimHash, owner: thirdParty, state: "pending" }]], ["victim", "fixture", "withdrawn"]],
  ["the seller's own marker still in an earlier release's scan-state queue", [[{ hash: victimHash, owner: claim, state: "legacy" }]],
    ["fixture", "withdrawn"]],
  ["the same queued marker in a database from before read versions", [[{ hash: victimHash, owner: claim, state: "legacy" }], { readVersion: null }],
    ["fixture", "withdrawn"]],
  ["a third party's marker in an earlier release's scan-state queue", [[{ hash: victimHash, owner: thirdParty, state: "legacy" }]],
    ["victim", "fixture", "withdrawn"]],
];

for (const [name, args, ids] of upgradeCases) {
  test(`the read upgrade withholds by owner: ${name}`, () => {
    const started = startUpgraded(...args);
    assert.deepEqual(started.ids, ids, "the second start, with no reindex, sees the same rows");
    assert.ok(started.pending.every(Boolean), "every earlier rejection is reread");
    if (/[0-9a-f]{64}$/.test(args[1]?.sellerClaim ?? claim)) {
      assert.equal(started.ids.includes("victim"), !started.ownerHeld, "the upgrade withholds exactly what the live hold rule holds");
    }
  });
}

test("a requeued owner marker whose reply data is not an object holds the Listing through backoff and restart", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const locator = String(input).split("/").pop();
    return Response.json({ success: true, owner, data: locator === listingAt ? listing : "not-an-object" });
  });
  const frozen = Date.now();
  t.mock.method(Date, "now", () => frozen);
  const registration = { primaryClaim: claim, displayName: "seller", listingAnchors: [listingAt] };
  for (const pass of ["unread", "backing off"]) {
    const record = await indexRegistration(registration, undefined, async () => { throw new Error("offline"); });
    assert.deepEqual(record.listings, [], pass);
    assert.equal(store.hasPendingOwnerRevocationCandidate(hash, owner), true, pass);
  }
  assert.deepEqual(store.nextRevocationCandidates(hash, owner, 16), [], "the marker is waiting out its backoff");
  const moduleUrl = new URL("../src/catalog/store.js", import.meta.url).href;
  const code = `const s=await import(${JSON.stringify(moduleUrl)});
    console.log(JSON.stringify(s.hasPendingOwnerRevocationCandidate(${JSON.stringify(hash)}, ${JSON.stringify(claim)})));`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { encoding: "utf8", env: process.env });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout), true, "the hold survives a restart");
});

test("read version 2 runs once: a later rejection stays rejected across restarts", () => {
  store.recordRevocationProgress(laterHash, { unread: [], rejected: [laterMarker] });
  const moduleUrl = new URL("../src/catalog/store.js", import.meta.url).href;
  const code = `const s=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(s.hasPendingRevocationCandidates(${JSON.stringify(laterHash)})));`;
  for (let restart = 0; restart < 2; restart++) {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { encoding: "utf8", env: process.env });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout), false);
  }
});
