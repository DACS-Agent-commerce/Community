import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";

const directory = mkdtempSync(join(tmpdir(), "dacs-revocation-upgrade-"));
process.env.DACS_DIRECTORY_DATA = directory;
const seed = Buffer.alloc(32, 87);
const claim = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const sign = (message: string, encoding: BufferEncoding = "base64url") =>
  Buffer.from(ed25519Sign(Buffer.from(message), privateKeyFromSeed(seed))).toString(encoding);
const identity = { bundleVersion: "1", presentedBy: claim, presentedAt: 1, claims: [{ ref: claim }] };
const scope = {
  dacsVersion: "1", listingVersion: 1, listingId: "upgrade", seller: { displayName: "seller", identity: {
    ...identity, presentation: { kind: "per-claim", signatures: [{ ref: claim,
      signature: sign(`dacs-bundle-presentation:v1:${contentHash(identity)}`, "base64url") }] },
  } },
  offering: { title: "upgrade", description: "upgrade", category: "test", tags: [], deliverable: { kind: "storage-program" } },
  buyerRequirement: { requirementVersion: "1", required: [] },
  pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "deliver-storage-program" }],
  pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } }, terms: {}, validity: { notBefore: 1 },
};
const hash = contentHash(scope);
const listing = { ...scope, signature: { algorithm: "ed25519", signer: claim, value: sign(`dacs-listing:v1:${hash}`) } };
const at = (digit: string) => `stor-${digit.repeat(40)}`;
const [listingAt, missing, privateMarker, invalid] = ["1", "2", "3", "4"].map(at);
const otherHash = "b".repeat(64), revokedHash = "c".repeat(64), freshHash = "f".repeat(64);
const dbPath = join(directory, "directory.sqlite");
const seeded = new Database(dbPath);
// Exact old candidate schema, which recorded unavailable reads as rejected.
seeded.exec(`
  CREATE TABLE kv_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
  INSERT INTO kv_state VALUES ('schema-version','1',0), ('sr2-anchor-schema-version','2',0);
  INSERT INTO kv_state VALUES ('listing-admission-schema-version','1',0);
  CREATE TABLE revocation_candidates (
    listing_hash TEXT NOT NULL, locator TEXT NOT NULL, owner TEXT, content_hash TEXT,
    seq INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(listing_hash,locator)
  );
`);
const insert = seeded.prepare("INSERT INTO revocation_candidates VALUES (?,?,?,?,?,?)");
insert.run(hash, missing, null, "d".repeat(64), 1, "rejected");
insert.run(hash, privateMarker, null, "e".repeat(64), 2, "rejected");
insert.run(freshHash, invalid, `0x${claim.slice(-64)}`, null, 3, "pending");
insert.run(revokedHash, at("5"), `0x${claim.slice(-64)}`, null, 4, "rejected");
seeded.prepare("INSERT INTO kv_state VALUES ('catalog',?,0)").run(JSON.stringify({
  catalogVersion: "1", generatedAt: 100, sellers: [{ primaryClaim: claim, deals: [], listings: [
    { listingId: "upgrade", contentHash: hash, status: "active" },
    { listingId: "unaffected", contentHash: otherHash, status: "active" },
    { listingId: "revoked", contentHash: revokedHash, status: "revoked", revocationBinding: { markerContentHash: "f".repeat(64) } },
  ] }],
}));
seeded.close();
const store = await import("../src/catalog/store.js");
const { indexRegistration } = await import("../src/catalog/indexer.js");
test.after(() => rmSync(directory, { recursive: true, force: true }));

test("upgrade requeues prior rejected markers and immediately withholds affected active catalog rows", () => {
  assert.equal(store.hasPendingRevocationCandidates(hash), true);
  assert.deepEqual(store.nextRevocationCandidates(hash, null, 16), [missing, privateMarker]);
  store.admitRevocationCandidates(hash, [{ locator: missing, contentHash: "d".repeat(64) }]);
  assert.deepEqual(store.nextRevocationCandidates(hash, null, 16), [missing, privateMarker], "same bytes remain queued");
  assert.deepEqual(store.loadCatalog().sellers[0].listings.map((entry) => entry.listingId), ["unaffected", "revoked"]);
  assert.equal(store.loadCatalog().sellers[0].listings[1].revocation?.markerContentHash, "f".repeat(64));
});

test("upgraded 403/404 hints gain withdrawal authority only after a recovered marker verifies", async () => {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let now = originalNow(), recovered = false;
  Date.now = () => now;
  const markerScope = { listingId: "upgrade", listingVersion: 1, listingContentHash: hash, revokedAt: 1 };
  const marker = { ...markerScope, signature: { algorithm: "ed25519", signer: claim,
    value: sign(`dacs-revocation:v1:${contentHash(markerScope)}`) } };
  globalThis.fetch = async (input) => {
    const locator = String(input).split("/").pop();
    if (locator === listingAt || recovered) return Response.json({ success: true, owner: `0x${claim.slice(-64)}`,
      data: locator === listingAt ? listing : marker });
    const status = locator === privateMarker ? 403 : 404;
    return Response.json({ success: false, errorCode: status === 403 ? "PERMISSION_DENIED" : "NOT_FOUND" }, { status });
  };
  try {
    const registration = { primaryClaim: claim, displayName: "seller", listingAnchors: [listingAt] };
    const unavailable = await indexRegistration(registration, undefined, async () => { throw new Error("offline"); });
    assert.equal(unavailable.listings[0]?.status, "active");
    assert.equal(store.hasPendingRevocationCandidates(hash), true);
    assert.deepEqual(store.nextRevocationCandidates(hash, null, 16), []);
    recovered = true; now += 1_000;
    const restored = await indexRegistration(registration, unavailable, async () => { throw new Error("offline"); });
    assert.equal(restored.listings[0]?.status, "revoked");
    assert.equal(restored.listings[0]?.revocation?.listingContentHash, hash);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
});

test("migration runs once: a newly verified invalid marker stays rejected across restarts", () => {
  store.recordRevocationProgress(freshHash, { unread: [], rejected: [invalid] });
  const moduleUrl = new URL("../src/catalog/store.js", import.meta.url).href;
  const code = `const s=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify({pending:s.hasPendingRevocationCandidates(${JSON.stringify(freshHash)}),listings:s.loadCatalog().sellers[0].listings}));`;
  for (let restart = 0; restart < 2; restart++) {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { encoding: "utf8", env: process.env });
    assert.equal(child.status, 0, child.stderr);
    const actual = JSON.parse(child.stdout);
    assert.equal(actual.pending, false);
    assert.deepEqual(actual.listings.map((entry: { listingId: string }) => entry.listingId), ["unaffected", "revoked"]);
  }
});
