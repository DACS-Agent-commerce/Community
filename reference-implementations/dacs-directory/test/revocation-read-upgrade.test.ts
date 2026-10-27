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
insert.run(hash, ownerMarker, owner, "d".repeat(64), 1, "rejected");
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

test("upgrade from read version 1 requeues earlier rejections and withholds their active rows", () => {
  assert.deepEqual(store.nextRevocationCandidates(hash, owner, 16), [ownerMarker]);
  assert.equal(store.hasPendingOwnerRevocationCandidate(hash, owner), true);
  assert.deepEqual(store.nextRevocationCandidates(otherHash, null, 16), [otherMarker], "third-party rejections are reread too");
  assert.deepEqual(store.loadCatalog().sellers[0].listings.map((entry) => entry.listingId), ["unaffected"]);
});

test("a requeued owner marker whose reply data is not an object holds the Listing", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const locator = String(input).split("/").pop();
    return Response.json({ success: true, owner, data: locator === listingAt ? listing : "not-an-object" });
  });
  const registration = { primaryClaim: claim, displayName: "seller", listingAnchors: [listingAt] };
  const record = await indexRegistration(registration, undefined, async () => { throw new Error("offline"); });
  assert.deepEqual(record.listings, []);
  assert.equal(store.hasPendingOwnerRevocationCandidate(hash, owner), true);
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
