import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash } from "../src/catalog/canonical.js";
import { legacyListingHash } from "../src/catalog/legacyListingHash.js";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { findValidListingRevocation, storedListingHash, verifyListing, verifyListingRevocation, verifyStoredListing } from "../src/catalog/listingVerification.js";

type Obj = Record<string, unknown>;
const directory = mkdtempSync(join(tmpdir(), "dacs-historical-profiles-"));
process.env.DACS_DIRECTORY_DATA = directory;
const store = await import("../src/catalog/store.js");
const { indexRegistration } = await import("../src/catalog/indexer.js");
test.after(() => rmSync(directory, { recursive: true, force: true }));
const seed = Buffer.alloc(32, 67);
const claim = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const at = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;
const signature = (scope: Obj, prefix: string, hash = legacyListingHash) => ({
  algorithm: "ed25519", signer: claim,
  value: Buffer.from(ed25519Sign(Buffer.from(prefix + hash(scope)), privateKeyFromSeed(seed))).toString("base64url"),
});
function listing(listingId: string, extension: Obj = {}, hash = legacyListingHash) {
  const identity = { bundleVersion: "1", presentedBy: claim, presentedAt: 1, claims: [{ ref: claim }], ...extension };
  const scope = {
    dacsVersion: "1", listingVersion: 1, listingId, ...extension,
    seller: { displayName: "seller", identity: { ...identity, presentation: { kind: "per-claim", signatures: [{ ref: claim,
      signature: Buffer.from(signature(identity, "dacs-bundle-presentation:v1:", hash).value, "base64url").toString("hex") }] } } },
    offering: { title: listingId, description: "service", category: "test", tags: [], deliverable: { kind: "storage-program" } },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "deliver-storage-program" }],
    pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } }, terms: {}, validity: { notBefore: 1 },
  };
  return { scope, raw: { ...scope, signature: signature(scope, "dacs-listing:v1:", hash) }, hash: hash(scope) };
}
const extensions: Obj[] = [{ "e\u0301": "withdrawn" }, { nested: [{ "é": "first", "e\u0301": "second" }] }];

test("stored Base64URL Listings authenticate their historical Listing and presentation hashes while current admission stays strict", async () => {
  for (const extension of extensions) {
    const f = listing("historical", extension);
    const original = JSON.stringify(f.raw);
    assert.notEqual(f.hash, contentHash(f.scope));
    assert.equal(await verifyListing(f.raw), null);
    const verified = await verifyStoredListing(f.raw, at(1));
    assert.equal(verified?.contentHash, f.hash);
    assert.equal(storedListingHash(f.raw, f.hash), f.hash);
    assert.equal(await verifyStoredListing(f.raw, at(1), async () => null), null);
    assert.equal(await verifyStoredListing({ ...f.raw, offering: { ...f.raw.offering, title: "changed" } }, at(1)), null);
    assert.equal(await verifyStoredListing({ ...f.raw, signature: { ...f.raw.signature,
      value: Buffer.from(f.raw.signature.value, "base64url").toString("hex") } }, at(1)), null);
    assert.equal(JSON.stringify(f.raw), original);
  }
  const current = listing("current", extensions[0], contentHash);
  assert.equal((await verifyStoredListing(current.raw, at(1)))?.contentHash, current.hash);
  assert.equal((await verifyListing(current.raw))?.contentHash, current.hash);
});

test("withdrawal bindings carry the authenticated historical or current marker hash", async () => {
  const f = listing("withdrawal");
  const verified = await verifyListing(f.raw); assert.ok(verified);
  for (const hash of [legacyListingHash, contentHash]) for (const extension of extensions) {
    const scope = { listingId: "withdrawal", listingVersion: 1, listingContentHash: f.hash, revokedAt: 1, ...extension };
    const marker = { ...scope, signature: signature(scope, "dacs-revocation:v1:", hash) };
    assert.equal(await verifyListingRevocation(marker, verified, 1), true);
    const found = await findValidListingRevocation([at(2)], verified, 1, async () => marker);
    assert.equal(found?.markerContentHash, hash(scope));
    assert.equal(found?.listingContentHash, f.hash);
    for (const changed of [{ listingId: "another" }, { listingVersion: 2 }, { listingContentHash: "a".repeat(64) },
      { revokedAt: 2 }, { "e\u0301": "changed" }, { signature: { ...marker.signature, value: `${marker.signature.value}=` } }]) {
      assert.equal(await verifyListingRevocation({ ...marker, ...changed }, verified, 1), false, JSON.stringify(changed));
    }
    assert.equal(await verifyListingRevocation(marker, verified, 2), false);
    assert.equal(await verifyListingRevocation(marker, { ...verified, signer: `did:demos:agent:${"a".repeat(64)}` }, 1), false);
  }
});

test("a cold index retains an old signed withdrawal instead of publishing the Listing active", async (t) => {
  t.mock.method(Date, "now", () => 1_700_000_000_000);
  const original = globalThis.fetch;
  try {
    for (const [index, extension] of [{}, ...extensions].entries()) {
      const f = listing(`cold-${index}`, extension);
      const listingAt = at(10 + index * 2), markerAt = at(11 + index * 2);
      const markerScope = { listingId: f.scope.listingId, listingVersion: 1, listingContentHash: f.hash, revokedAt: 1,
        "e\u0301": "withdrawn" };
      const marker = { ...markerScope, signature: signature(markerScope, "dacs-revocation:v1:") };
      store.admitRevocationCandidates(f.hash, [{ locator: markerAt, owner: `0x${claim.slice(-64)}` }]);
      let readable = true;
      globalThis.fetch = async (input) => {
        const locator = String(input).split("/").pop();
        const raw = locator === listingAt ? f.raw : locator === markerAt && readable ? marker : null;
        return raw ? Response.json({ success: true, owner: `0x${claim.slice(-64)}`, data: raw })
          : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
      };
      const registration = { primaryClaim: claim, displayName: "seller", listingAnchors: [listingAt] };
      const read = () => indexRegistration(registration, undefined, async () => { throw new Error("offline"); });
      const first = await read();
      assert.equal(first.listings[0]?.status, "revoked", `cold index ${index}`);
      assert.equal(first.listings[0]?.revocation?.markerContentHash, legacyListingHash(markerScope));
      readable = false;
      const repeated = await read();
      assert.equal(repeated.listings[0]?.status, "revoked", "a later unreadable marker keeps its authenticated withdrawal");
      assert.deepEqual(repeated.listings[0]?.revocation, first.listings[0]?.revocation);
    }
  } finally { globalThis.fetch = original; }
});
