import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import { ed25519Sign, privateKeyFromSeed } from "@kynesyslabs/dacs/crypto";
import { contentHash } from "../src/catalog/canonical.js";
import { legacyListingHash } from "../src/catalog/legacyListingHash.js";
import { storedListingHash, verifyListing, verifyStoredListing } from "../src/catalog/listingVerification.js";
import { verifyReferencedArtifactSignature } from "../src/catalog/bundlePolicy.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/listing-nested-phase-metadata.json", import.meta.url), "utf8"));
const at = `stor-${"6".repeat(40)}`;
const raw = { ...fixture.listing, signature: { ...fixture.listing.signature,
  value: Buffer.from(fixture.listing.signature.value, "base64url").toString("hex") } };
const pin = { encoding: "lowercase-hex", sellerPrimaryClaim: raw.signature.signer,
  listingId: raw.listingId, listingVersion: raw.listingVersion, contentHash: fixture.contentHash };
const offline = async () => null;

test("exact historical imports retain the original Listing and presentation hash profiles", async () => {
  const previous = process.env.DACS_HISTORICAL_LISTING_IMPORTS;
  const seed = createHash("sha256").update("DACS Directory nested phase metadata public test fixture").digest();
  const sign = (prefix: string, hash: string) =>
    Buffer.from(ed25519Sign(Buffer.from(prefix + hash), privateKeyFromSeed(seed))).toString("hex");
  try {
    for (const extension of [{ ascii: "extension" }, { "e\u0301": "extension" },
      { nested: [{ "é": "first", "e\u0301": "second" }] }]) {
      const { presentation: _presentation, ...identityScope } = fixture.listing.seller.identity;
      const identity = { ...identityScope, ...extension };
      const { signature: _signature, ...originalScope } = fixture.listing;
      const scope = { ...originalScope, ...extension, seller: { ...originalScope.seller, identity: {
        ...identity, presentation: { kind: "per-claim", signatures: [{ ref: raw.signature.signer,
          signature: sign("dacs-bundle-presentation:v1:", legacyListingHash(identity)) }] },
      } } };
      const hash = legacyListingHash(scope);
      const listing = { ...scope, signature: { ...raw.signature, value: sign("dacs-listing:v1:", hash) } };
      const original = JSON.stringify(listing);
      process.env.DACS_HISTORICAL_LISTING_IMPORTS = JSON.stringify({ [at]: { ...pin, contentHash: hash } });
      assert.equal((await verifyStoredListing(listing, at))?.contentHash, hash);
      assert.equal(storedListingHash(listing), hash);
      assert.equal(await verifyReferencedArtifactSignature({ kind: "dacs-1-listing", raw: listing, locator: at }), true);
      assert.equal(await verifyStoredListing(listing, `stor-${"7".repeat(40)}`), null);
      assert.equal(await verifyStoredListing(listing, at, offline), null);
      assert.equal(await verifyListing(listing), null, "strict admission never selects an import");
      const tampered = { ...listing, offering: { ...listing.offering, title: "changed" } };
      process.env.DACS_HISTORICAL_LISTING_IMPORTS = JSON.stringify({ [at]: {
        ...pin, contentHash: legacyListingHash({ ...scope, offering: tampered.offering }),
      } });
      assert.equal(await verifyStoredListing(tampered, at), null, "a repinned hash cannot replace either signature");
      assert.equal(JSON.stringify(listing), original);
    }
  } finally {
    if (previous === undefined) delete process.env.DACS_HISTORICAL_LISTING_IMPORTS;
    else process.env.DACS_HISTORICAL_LISTING_IMPORTS = previous;
  }
});

test("historical import is explicit, exact and re-verifies the original signed scope", async () => {
  const previous = process.env.DACS_HISTORICAL_LISTING_IMPORTS;
  const original = JSON.stringify(raw);
  const configure = (value: unknown) => { process.env.DACS_HISTORICAL_LISTING_IMPORTS = JSON.stringify(value); };
  try {
    delete process.env.DACS_HISTORICAL_LISTING_IMPORTS;
    assert.equal(await verifyListing(raw), null);
    assert.equal(await verifyStoredListing(raw, at), null, "no encoding auto-detection without provenance");
    configure({ [at]: pin });
    const verified = await verifyStoredListing(raw, at);
    assert.equal(verified?.contentHash, fixture.contentHash);
    assert.equal(verified?.profile, "dacs-v0.1");
    assert.deepEqual(verified?.listing, fixture.listing, "only the envelope is normalized in memory");
    assert.equal(await verifyReferencedArtifactSignature({ kind: "dacs-1-listing", raw, locator: at }), true,
      "the compatibility bundle reader retains the same native provenance");
    assert.equal(await verifyReferencedArtifactSignature({ kind: "dacs-1-listing", raw }), false,
      "an unlocated compatibility reference cannot select an import");
    assert.equal(JSON.stringify(raw), original, "stored bytes stay intact");
    assert.equal(await verifyStoredListing(raw, `stor-${"7".repeat(40)}`), null, "native pointer is pinned");
    assert.equal(await verifyStoredListing(raw, at, offline), null, "saved pin never substitutes for key verification");
    for (const changed of [
      { encoding: "standard-base64-padded" }, { sellerPrimaryClaim: `did:demos:agent:${"a".repeat(64)}` },
      { listingId: "another-listing" }, { listingVersion: 2 }, { contentHash: "f".repeat(64) },
      { contentHash: undefined }, { encoding: undefined },
    ]) {
      configure({ [at]: { ...pin, ...changed } });
      assert.equal(await verifyStoredListing(raw, at), null, JSON.stringify(changed));
    }
    configure({ [at]: pin });
    for (const value of [raw.signature.value.toUpperCase(), `0x${raw.signature.value}`, `${raw.signature.value} `,
      raw.signature.value.slice(2), `${raw.signature.value.slice(0, -2)}zz`]) {
      assert.equal(await verifyStoredListing({ ...raw, signature: { ...raw.signature, value } }, at), null,
        "declared lowercase hex has one exact spelling");
    }
    const tampered = { ...raw, offering: { ...raw.offering, title: "changed after signing" } };
    const unsigned = { ...tampered }; delete unsigned.signature;
    configure({ [at]: { ...pin, contentHash: contentHash(unsigned) } });
    assert.equal(await verifyStoredListing(tampered, at), null, "even a repinned hash cannot rescue a stale signature");
    configure({ [at]: pin });
    assert.equal(await verifyStoredListing({ ...raw, signatures: [] }, at), null);
    assert.equal(await verifyStoredListing({ ...raw, dacsVersion: "2", agentId: raw.signature.signer }, at), null,
      "historical current artifacts never retry through the draft SDK profile");
    for (const config of ["invalid json", "null", "[]", "{}", JSON.stringify({ [at]: null }), " ".repeat(65_537)]) {
      process.env.DACS_HISTORICAL_LISTING_IMPORTS = config;
      assert.equal(await verifyStoredListing(raw, at), null, "malformed provenance fails closed");
      assert.ok(await verifyStoredListing(fixture.listing, at), "canonical new artifacts keep strict admission");
    }
    configure(Object.fromEntries(Array.from({ length: 257 }, (_, n) => [
      `stor-${n.toString(16).padStart(40, "0")}`, pin,
    ])));
    assert.equal(await verifyStoredListing(raw, at), null, "provenance inventory is bounded");
  } finally {
    if (previous === undefined) delete process.env.DACS_HISTORICAL_LISTING_IMPORTS;
    else process.env.DACS_HISTORICAL_LISTING_IMPORTS = previous;
  }
});
