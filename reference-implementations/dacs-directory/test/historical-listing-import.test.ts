import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { contentHash } from "../src/catalog/canonical.js";
import {
  verifyListing,
  verifyListingResult,
  verifyStoredListing,
  verifyStoredListingResult,
} from "../src/catalog/listingVerification.js";
import { verifyReferencedArtifactSignature } from "../src/catalog/bundlePolicy.js";

// A Listing the pinned SDK reader admits; only its envelope is re-encoded as historical hex below.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/listing-public-storage.json", import.meta.url), "utf8"));
const at = `stor-${"6".repeat(40)}`;
const raw = { ...fixture.listing, signature: { ...fixture.listing.signature,
  value: Buffer.from(fixture.listing.signature.value, "base64url").toString("hex") } };
const pin = { encoding: "lowercase-hex", sellerPrimaryClaim: raw.signature.signer,
  listingId: raw.listingId, listingVersion: raw.listingVersion, contentHash: fixture.contentHash };
const offline = async () => null;

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

// /register before main 5483882 wrote the wallet's hex into the ListingSignature
// as well as the identity presentation (c07560b build-listing and register page).
const oldSeed = Uint8Array.from(Buffer.alloc(32, 41));
const oldKey = privateKeyFromSeed(oldSeed);
const oldClaim = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(oldSeed))).toString("hex")}`;
const signHex = (message: string, key = oldKey) =>
  Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), key)).toString("hex");

function oldPublisherListing(
  presentation: (hex: string) => string = (hex) => hex,
  listing: (hex: string) => string = (hex) => hex,
  presentationKey = oldKey,
) {
  const identity: Record<string, unknown> = { bundleVersion: "1", presentedBy: oldClaim, presentedAt: 1, claims: [{ ref: oldClaim }] };
  identity.presentation = { kind: "per-claim", signatures: [{ ref: oldClaim,
    signature: presentation(signHex(`dacs-bundle-presentation:v1:${contentHash(identity)}`, presentationKey)) }] };
  const scope = {
    dacsVersion: "1", listingVersion: 1, listingId: "old-publisher",
    seller: { displayName: "Old", identity },
    offering: { title: "Old", description: "published before the upgrade", category: "services.other", tags: [],
      deliverable: { kind: "storage-program" } },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" },
      { kind: "pay-x402", parameters: { rail: "pay-x402" } }, { kind: "deliver-storage-program" }],
    pricing: { kind: "fixed", price: { amount: "1", currency: "USDC" } },
    acceptedRails: [{ railId: "pay-x402", kind: "x402" }], terms: { refundPolicy: "none" }, validity: { notBefore: 1 },
  };
  const hash = contentHash(scope);
  const value = listing(signHex(`dacs-listing:v1:${hash}`));
  return { raw: { ...scope, signature: { algorithm: "ed25519", signer: oldClaim, value } } as Record<string, unknown>, hash };
}

test("a pin retains a Listing the earlier publisher wrote with wallet hex in both signatures", async () => {
  const previous = process.env.DACS_HISTORICAL_LISTING_IMPORTS;
  const configure = (hash: string) => {
    process.env.DACS_HISTORICAL_LISTING_IMPORTS = JSON.stringify({ [at]: { encoding: "lowercase-hex",
      sellerPrimaryClaim: oldClaim, listingId: "old-publisher", listingVersion: 1, contentHash: hash } });
  };
  try {
    const { raw: old, hash } = oldPublisherListing();
    const original = JSON.stringify(old);
    delete process.env.DACS_HISTORICAL_LISTING_IMPORTS;
    assert.deepEqual(await verifyStoredListingResult(old, at), { ok: false, code: "LISTING_SIGNATURE_INVALID" },
      "without a pin the hex Listing stays excluded");
    configure(hash);
    const imported = await verifyStoredListingResult(old, at);
    assert.equal(imported.ok, true, JSON.stringify(imported));
    assert.equal(imported.ok && imported.value.contentHash, hash);
    assert.equal(imported.ok && imported.value.sellerClaim, oldClaim);
    assert.equal(imported.ok && imported.value.profile, "dacs-v0.1");
    assert.equal(await verifyReferencedArtifactSignature({ kind: "dacs-1-listing", raw: old, locator: at }), true,
      "deal evidence reads the pinned Listing through the same import");
    assert.equal(JSON.stringify(old), original, "stored bytes stay intact");
    assert.equal(await verifyStoredListing(old, `stor-${"7".repeat(40)}`), null, "native pointer is pinned");

    // Each variant is re-signed and re-pinned, so only the presentation spelling or key differs.
    // The presentation is read as every current Listing's is: base64url or the wallet's hex.
    const otherKey = privateKeyFromSeed(Uint8Array.from(Buffer.alloc(32, 42)));
    for (const [label, variant] of [
      ["uppercase hex", oldPublisherListing((hex) => hex.toUpperCase())],
      ["base64url", oldPublisherListing((hex) => Buffer.from(hex, "hex").toString("base64url"))],
    ] as const) {
      configure(variant.hash);
      assert.equal((await verifyStoredListing(variant.raw, at))?.contentHash, variant.hash, `pinned presentation: ${label}`);
    }
    for (const [label, variant] of [
      ["0x hex", oldPublisherListing((hex) => `0x${hex}`)],
      ["truncated hex", oldPublisherListing((hex) => hex.slice(2))],
      ["padded base64", oldPublisherListing((hex) => Buffer.from(hex, "hex").toString("base64"))],
      ["another key", oldPublisherListing(undefined, undefined, otherKey)],
      ["base64url by another key",
        oldPublisherListing((hex) => Buffer.from(hex, "hex").toString("base64url"), undefined, otherKey)],
    ] as const) {
      configure(variant.hash);
      assert.equal(await verifyStoredListing(variant.raw, at), null, `pinned presentation: ${label}`);
    }
  } finally {
    if (previous === undefined) delete process.env.DACS_HISTORICAL_LISTING_IMPORTS;
    else process.env.DACS_HISTORICAL_LISTING_IMPORTS = previous;
  }
});

// A Listing as main f13f233's /register publishes it today
// (build-listing/route.ts:157-241, register/page.tsx:285-294): a canonical
// base64url ListingSignature, and the wallet's hex in the identity presentation.
function mainRegisterListing(
  presentation: (signature: Buffer) => string = (signature) => signature.toString("hex"),
  presentationKey = oldKey,
  presentationMessage = (bundleHash: string) => `dacs-bundle-presentation:v1:${bundleHash}`,
) {
  const identityScope = { bundleVersion: "1", presentedBy: oldClaim, presentedAt: 1_760_000_000_000, claims: [{ ref: oldClaim }] };
  const signature = Buffer.from(ed25519Sign(Buffer.from(presentationMessage(contentHash(identityScope)), "utf8"), presentationKey));
  const scope = {
    dacsVersion: "1", listingId: "main-register", listingVersion: 1, requiredCapabilities: ["SR-2"],
    seller: {
      identity: { ...identityScope, presentation: { kind: "per-claim", signatures: [{ ref: oldClaim, signature: presentation(signature) }] } },
      displayName: "Main seller",
    },
    offering: { title: "Main seller", description: "published by main /register", category: "services.other", tags: [],
      deliverable: { kind: "storage-program", accessModel: "public" } },
    buyerRequirement: { requirementVersion: "1", required: [], preferredPresentation: "any" },
    pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" },
      { kind: "pay-x402", parameters: { rail: "x402:default" } }, { kind: "deliver-storage-program" }],
    pricing: { kind: "fixed", price: { amount: "1", currency: "USDC" } },
    acceptedRails: [{ railId: "x402:default" }], terms: {}, validity: { notBefore: 1_760_000_000_000 },
  };
  const hash = contentHash(scope);
  const value = Buffer.from(ed25519Sign(Buffer.from(`dacs-listing:v1:${hash}`, "utf8"), oldKey)).toString("base64url");
  return { raw: { ...scope, signature: { algorithm: "ed25519", signer: oldClaim, value } } as Record<string, unknown>, hash };
}

test("a Listing main's /register publishes stays in the catalog; a bad presentation is refused in either spelling", async () => {
  const previous = process.env.DACS_HISTORICAL_LISTING_IMPORTS;
  const configure = (hash: string) => {
    process.env.DACS_HISTORICAL_LISTING_IMPORTS = JSON.stringify({ [at]: { encoding: "lowercase-hex",
      sellerPrimaryClaim: oldClaim, listingId: "main-register", listingVersion: 1, contentHash: hash } });
  };
  const flip = (signature: Buffer) => Buffer.from(signature.map((byte, index) => index === 0 ? byte ^ 1 : byte));
  const otherKey = privateKeyFromSeed(Uint8Array.from(Buffer.alloc(32, 42)));
  try {
    delete process.env.DACS_HISTORICAL_LISTING_IMPORTS;
    const main = mainRegisterListing();
    const original = JSON.stringify(main.raw);
    const stored = await verifyStoredListingResult(main.raw, at);
    assert.equal(stored.ok, true, JSON.stringify(stored));
    assert.equal(stored.ok && stored.value.contentHash, main.hash);
    assert.equal(stored.ok && stored.value.sellerClaim, oldClaim);
    assert.equal(stored.ok && stored.value.profile, "dacs-v0.1");
    assert.equal((await verifyListingResult(main.raw)).ok, true, "admission reads it without a pin");
    assert.equal(await verifyReferencedArtifactSignature({ kind: "dacs-1-listing", raw: main.raw, locator: at }), true,
      "deal evidence reads it through the same verifier");
    assert.equal(JSON.stringify(main.raw), original, "stored bytes stay intact");
    configure(main.hash);
    assert.equal((await verifyStoredListing(main.raw, at))?.contentHash, main.hash, "an operator pin keeps it too");

    // Each variant is re-signed, so only the presentation spelling, key or bytes differ.
    for (const [label, variant] of [
      ["base64url (SDK sellers and this release's /register)", mainRegisterListing((signature) => signature.toString("base64url"))],
      ["uppercase hex (main stored the wallet's case)", mainRegisterListing((signature) => signature.toString("hex").toUpperCase())],
    ] as const) {
      delete process.env.DACS_HISTORICAL_LISTING_IMPORTS;
      assert.equal((await verifyStoredListing(variant.raw, at))?.contentHash, variant.hash, label);
      assert.equal((await verifyListingResult(variant.raw)).ok, true, label);
    }
    for (const [label, variant] of [
      ["hex by another key", mainRegisterListing(undefined, otherKey)],
      ["base64url by another key", mainRegisterListing((signature) => signature.toString("base64url"), otherKey)],
      ["hex with one bit flipped", mainRegisterListing((signature) => flip(signature).toString("hex"))],
      ["base64url with one bit flipped", mainRegisterListing((signature) => flip(signature).toString("base64url"))],
      ["hex over other bytes", mainRegisterListing(undefined, undefined, (bundleHash) => `dacs-listing:v1:${bundleHash}`)],
      ["base64url over other bytes",
        mainRegisterListing((signature) => signature.toString("base64url"), undefined, (bundleHash) => `dacs-listing:v1:${bundleHash}`)],
      ["0x hex", mainRegisterListing((signature) => `0x${signature.toString("hex")}`)],
      ["padded base64", mainRegisterListing((signature) => signature.toString("base64"))],
      ["hex with a trailing space", mainRegisterListing((signature) => `${signature.toString("hex")} `)],
    ] as const) {
      delete process.env.DACS_HISTORICAL_LISTING_IMPORTS;
      assert.deepEqual(await verifyStoredListingResult(variant.raw, at), { ok: false, code: "IDENTITY_PRESENTATION_INVALID" }, label);
      configure(variant.hash);
      assert.deepEqual(await verifyStoredListingResult(variant.raw, at), { ok: false, code: "IDENTITY_PRESENTATION_INVALID" },
        `a pin cannot rescue it: ${label}`);
    }
  } finally {
    if (previous === undefined) delete process.env.DACS_HISTORICAL_LISTING_IMPORTS;
    else process.env.DACS_HISTORICAL_LISTING_IMPORTS = previous;
  }
});
