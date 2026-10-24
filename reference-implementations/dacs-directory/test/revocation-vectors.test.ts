import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import {
  findValidListingRevocation,
  verifyListingRevocation,
  type RevocationCandidateProgress,
  type VerifiedListing,
} from "../src/catalog/listingVerification.js";
import type { ResolvePrimaryClaimKey } from "../src/catalog/primaryClaimKey.js";
import type { LegacyMvpListing, Listing } from "@kynesyslabs/dacs/artifacts";

// DACS-1 RB-1..RB-6 against the pinned revocation-binding vectors (SPEC_PIN), then RB-4's tuple
// checks against markers that are validly signed, so only the tuple rule can reject them.
type Obj = Record<string, unknown>;
interface Vector {
  name: string; expected: string; markerRead: { status: string; fixture?: string | null; signatureOverride?: string };
  surface?: { binding?: string | null }; want: { revocationCheck: string; failedAt?: string };
}
const vectors = JSON.parse(readFileSync(new URL("./fixtures/dacs-standard/revocation-binding-v0.3.json", import.meta.url), "utf8")) as {
  publicKeys: Record<string, string>; vectors: Vector[];
  fixtures: { listing: Obj & { listingId: string; listingVersion: number; listingContentHash: string; signer: string; sellerPrimaryClaim: string };
    markers: Record<string, Obj & { signature: Obj }>; bindings: Record<string, Obj & { markerAnchor: { locator: string } }> };
};
const { fixtures } = vectors;
const vectorKeys: ResolvePrimaryClaimKey = async (claim, algorithm) => vectors.publicKeys[claim] && algorithm === "ed25519"
  ? { canonicalClaim: claim, algorithm, publicKey: Uint8Array.from(Buffer.from(vectors.publicKeys[claim], "base64url")) } : null;
/** A verified current Listing as RB-2 reads it: its id and exact `presentedBy` bytes. */
const currentListing = (listingId: string, presentedBy: string) =>
  ({ listingId, seller: { identity: { presentedBy } }, signature: { signer: presentedBy } }) as unknown as Listing;
const vectorListing: VerifiedListing = {
  listing: currentListing(fixtures.listing.listingId, fixtures.listing.sellerPrimaryClaim), scope: { listingId: fixtures.listing.listingId },
  contentHash: fixtures.listing.listingContentHash, signer: fixtures.listing.signer, sellerClaim: fixtures.listing.sellerPrimaryClaim, profile: "dacs-v0.1",
};
/** Reader-surface checks (well-known index integrity, catalog freshness, a received tombstone) that a producer never consumes. */
const SURFACE_ONLY = new Set(["requiredBinding", "surfaceIntegrity", "statusBindingConsistency", "catalogFreshness"]);

test("revocation-binding vectors: the marker reads a catalog producer performs give the vector's verdict and binding", async () => {
  const applied: string[] = [];
  for (const vector of vectors.vectors) {
    if (vector.markerRead.status === "not-applicable" || SURFACE_ONLY.has(vector.want.failedAt ?? "")) continue;
    const fixtureBinding = fixtures.bindings[vector.surface?.binding ?? "opaque-name"];
    const at = fixtureBinding.markerAnchor.locator;
    const fixture = vector.markerRead.fixture ? fixtures.markers[vector.markerRead.fixture] : null;
    const marker = fixture && vector.markerRead.signatureOverride
      ? { ...fixture, signature: { ...fixture.signature, value: vector.markerRead.signatureOverride } } : fixture;
    const progress: RevocationCandidateProgress = { unread: [], rejected: [] };
    const binding = await findValidListingRevocation([at], vectorListing, fixtures.listing.listingVersion,
      async () => vector.markerRead.status === "ok" ? marker : null, vectorKeys, progress);
    const verdict = binding ? "revoked" : progress.unread.length > 0 ? "indeterminate (unread)" : "indeterminate (rejected)";
    const { producerWriteInputs: _, ...published } = fixtureBinding;
    const overrides = (vector as { bindingOverrides?: Obj }).bindingOverrides ?? {};
    if (vector.want.revocationCheck === "revoked") {
      assert.deepEqual(binding, published, vector.name);
    } else if (vector.want.failedAt === "logicalAddress" || vector.want.failedAt === "markerContentHash") {
      // The override corrupts a received binding. A producer derives its binding from the marker it
      // verified, so it publishes the vector's correct values and never the overridden one.
      assert.deepEqual(binding, published, vector.name);
      assert.notEqual(binding?.[vector.want.failedAt], overrides[vector.want.failedAt], vector.name);
    } else {
      assert.equal(verdict, vector.want.failedAt === "markerFetch" ? "indeterminate (unread)" : "indeterminate (rejected)", vector.name);
    }
    applied.push(vector.name);
  }
  assert.deepEqual(applied.sort(), [
    "binding-logical-address-mismatch", "binding-marker-content-hash-mismatch", "convention-name-binding-resolves-revoked",
    "marker-anchor-unreachable", "marker-signature-invalid", "opaque-name-binding-resolves-revoked",
    "valid-revocation-precedes-active-mirror", "validly-signed-marker-wrong-listing-version",
  ]);
  assert.equal(vectors.vectors.length, 14, "every other vector is a reader-surface check");
});

const seed = Uint8Array.from(Buffer.alloc(32, 83));
const otherSeed = Uint8Array.from(Buffer.alloc(32, 84));
const didOf = (from: Uint8Array) => `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(from))).toString("hex")}`;
const listingHash = "c".repeat(64);
const listing: VerifiedListing = {
  listing: currentListing("svc", didOf(seed)), scope: { listingId: "svc" }, contentHash: listingHash, signer: didOf(seed), sellerClaim: didOf(seed), profile: "dacs-v0.1",
};
const signed = async (scope: Obj, key = seed, envelope: Obj = {}) => ({
  ...scope,
  signature: { algorithm: "ed25519", signer: didOf(seed), ...envelope,
    value: Buffer.from(await ed25519Sign(Buffer.from(`dacs-revocation:v1:${contentHash(scope)}`, "utf8"), privateKeyFromSeed(key))).toString("base64url") },
});

test("RB-4: a validly signed marker revokes only the exact listing tuple, signed by the listing's own signer", async () => {
  const tuple = { listingId: "svc", listingVersion: 2, listingContentHash: listingHash, revokedAt: 1 };
  const verdict = async (marker: Obj, expectedVersion = 2, against: VerifiedListing = listing) => verifyListingRevocation(marker, against, expectedVersion);
  assert.equal(await verdict(await signed(tuple)), true);
  assert.equal(await verdict(await signed({ ...tuple, reason: "withdrawn" })), true, "an optional reason is part of the signed scope");
  assert.equal(await verdict(await signed({ ...tuple, revokedAt: Number.MAX_SAFE_INTEGER })), true, "the largest safe integer is in range");
  const rejected: Record<string, boolean> = {
    "another listingId": await verdict(await signed({ ...tuple, listingId: "svc-2" })),
    "another listingVersion": await verdict(await signed({ ...tuple, listingVersion: 3 })),
    "the listingVersion as a string": await verdict(await signed({ ...tuple, listingVersion: "2" })),
    "a version the caller does not expect": await verdict(await signed(tuple), 3),
    "another listingContentHash": await verdict(await signed({ ...tuple, listingContentHash: "d".repeat(64) })),
    "a listingContentHash that is not a string": await verdict(await signed({ ...tuple, listingContentHash: 7 })),
    "a revokedAt that is not a number": await verdict(await signed({ ...tuple, revokedAt: "1" })),
    "another key's signature": await verdict(await signed(tuple, otherSeed)),
    "an envelope naming another signer": await verdict(await signed(tuple, seed, { signer: didOf(otherSeed) })),
    "a non-Ed25519 algorithm": await verdict(await signed(tuple, seed, { algorithm: "ecdsa-secp256k1" })),
    "a listing signed by someone else": await verdict(await signed(tuple), 2, { ...listing, signer: didOf(otherSeed) }),
    // The SDK canonicaliser refuses such a number, so the marker is signed over the JCS text a
    // producer would emit. The canonicalizer may reject it before the explicit magnitude check.
    "a revokedAt beyond the safe-integer range": await (async () => {
      const unsafe: Obj = { ...tuple, revokedAt: Number.MAX_SAFE_INTEGER + 2 };
      const jcs = JSON.stringify(Object.fromEntries(Object.entries(unsafe).sort(([a], [b]) => a < b ? -1 : 1)));
      const value = Buffer.from(await ed25519Sign(Buffer.from(`dacs-revocation:v1:${createHash("sha256").update(jcs).digest("hex")}`, "utf8"),
        privateKeyFromSeed(seed))).toString("base64url");
      return verdict({ ...unsafe, signature: { algorithm: "ed25519", signer: didOf(seed), value } });
    })(),
    "no signature": await verdict({ ...tuple }),
    "a signature list": await verdict({ ...tuple, signature: [(await signed(tuple)).signature] }),
    "a bare signature string": await verdict({ ...tuple, signature: (await signed(tuple)).signature.value }),
    "an envelope signer that is not a string": await verdict(await signed(tuple, seed, { signer: 7 })),
    "an envelope value that is not a string": await verdict({ ...tuple, signature: { ...(await signed(tuple)).signature, value: 7 } }),
    "a hex envelope value": await verdict({ ...tuple, signature: { ...(await signed(tuple)).signature,
      value: Buffer.from((await signed(tuple)).signature.value as string, "base64url").toString("hex") } }),
    "an envelope signer with no resolvable key": await verdict(await signed(tuple, seed, { signer: `cci:${"8".repeat(64)}` })),
  };
  assert.deepEqual(rejected, Object.fromEntries(Object.keys(rejected).map((name) => [name, false])));
  // A legacy listing names its id as serviceId.
  const legacy: VerifiedListing = { ...listing, scope: { serviceId: "svc" }, listing: { serviceId: "svc" } as unknown as LegacyMvpListing, profile: "legacy-sdk-v0.1" };
  assert.equal(await verdict(await signed(tuple), 2, legacy), true);
  assert.equal(await verdict(await signed({ ...tuple, listingId: "other" }), 2, legacy), false);
});

test("RB-4: the first valid marker in the batch wins and the binding names it; unread and rejected candidates are reported", async () => {
  const tuple = { listingId: "svc", listingVersion: 2, listingContentHash: listingHash, revokedAt: 1 };
  const valid = await signed(tuple);
  const stored: Record<string, Obj | null> = { "stor-bad": await signed({ ...tuple, listingVersion: 3 }), "stor-gone": null, "stor-good": valid };
  const progress: RevocationCandidateProgress = { unread: [], rejected: [] };
  const binding = await findValidListingRevocation(["stor-bad", "stor-gone", "stor-good", "stor-bad"], listing, 2,
    async (at) => stored[at], undefined, progress);
  assert.deepEqual(binding, {
    sellerPrimaryClaim: listing.sellerClaim, listingId: "svc", listingVersion: 2, listingContentHash: listingHash,
    logicalAddress: `dacs1-revoked:${listing.sellerClaim.replace(/:/g, "%3A")}:svc:v2`,
    markerAnchor: { kind: "storage-program", locator: "stor-good" }, markerContentHash: contentHash(tuple),
  });
  assert.deepEqual(progress, { unread: ["stor-gone"], rejected: ["stor-bad"] });
  // The batch limit is honoured: a valid marker past it is not read.
  const reads: string[] = [];
  assert.equal(await findValidListingRevocation(["stor-bad", "stor-good"], listing, 2, async (at) => { reads.push(at); return stored[at]; }, undefined, undefined, 1), null);
  assert.deepEqual(reads, ["stor-bad"]);
});

test("the revocation fixture bytes match SPEC_PIN", () => {
  const name = "revocation-binding-v0.3.json";
  const raw = readFileSync(new URL(`./fixtures/dacs-standard/${name}`, import.meta.url));
  const pin = readFileSync(new URL("../SPEC_PIN", import.meta.url), "utf8");
  const line = pin.split("\n").find(line => line.includes(name));
  assert.ok(line);
  assert.equal(createHash("sha256").update(raw).digest("hex"), line.trim().split(/\s+/).at(-1));
});

test("upstream well-known surface vectors exercise the actual entry parser and integrity gate", async t => {
  const { listingIndexEntryIsComplete, crawlDomain } = await import("../src/catalog/wellknown.js");
  const surfaceCases = vectors.vectors.filter(vector =>
    vector.markerRead.status === "not-applicable" || SURFACE_ONLY.has(vector.want.failedAt ?? ""));
  assert.equal(surfaceCases.length, 6);
  for (const vector of surfaceCases) await t.test(vector.name, async t => {
    if (vector.want.failedAt === "catalogFreshness") {
      t.skip("Out of scope: Directory produces catalogs; it does not consume remote catalog records or their age.");
      return;
    }
    if (vector.want.failedAt === "surfaceIntegrity") {
      const result = await crawlDomain("fixture.example", { validateUrl: async () => ({} as never), fetchJson: async url => {
        const body = url.endsWith("agent.json")
          ? { dacs: { dacsVersion: "1", listings: { indexUrl: "https://fixture.example/listings.json", indexHash: `sha256-${"0".repeat(64)}` } } }
          : { indexVersion: "1", generatedAt: 1, listings: [] };
        return { body, raw: JSON.stringify(body) };
      } });
      assert.ok("error" in result);
      assert.match(result.error, /indexHash mismatch/);
      return;
    }
    const surfaces = (vector as unknown as { surfaces?: Array<{ status: string; binding?: string | null }> }).surfaces
      ?? [vector.surface as { status: string; binding?: string | null }];
    const complete = surfaces.map(surface => listingIndexEntryIsComplete({
      listingId: fixtures.listing.listingId, version: fixtures.listing.listingVersion,
      contentHash: fixtures.listing.listingContentHash,
      anchor: { kind: "storage-program", locator: fixtures.bindings["opaque-name"].markerAnchor.locator },
      summary: { title: "Service", category: "services.other", tags: [] },
      status: surface.status,
      ...(surface.binding ? { revocation: fixtures.bindings[surface.binding] } : {}),
    }, fixtures.listing.sellerPrimaryClaim));
    assert.equal(complete.every(Boolean) ? "absent" : "indeterminate", vector.want.revocationCheck);
  });
});


test("both listing-index statuses require a complete summary before completing a withdrawal check", async () => {
  const { listingIndexEntryIsComplete } = await import("../src/catalog/wellknown.js");
  const binding = fixtures.bindings["opaque-name"];
  const summary = { title: "Service", category: "services.other", tags: ["service"], priceHint: "1 DEM" };
  for (const status of ["active", "revoked"]) {
    const entry = { listingId: fixtures.listing.listingId, version: fixtures.listing.listingVersion,
      contentHash: fixtures.listing.listingContentHash,
      anchor: { kind: "storage-program", locator: binding.markerAnchor.locator },
      summary, status, ...(status === "revoked" ? { revocation: binding } : {}) };
    const complete = (value: unknown) => listingIndexEntryIsComplete(value, fixtures.listing.sellerPrimaryClaim);
    assert.equal(complete(entry), true, `${status}: complete summary`);
    for (const malformed of [undefined, null, [], "summary", {}, { ...summary, title: 7 },
      { ...summary, category: null }, { ...summary, tags: "service" }, { ...summary, tags: [7] },
      { ...summary, priceHint: 7 }]) {
      assert.equal(complete({ ...entry, summary: malformed }), false, `${status}: ${JSON.stringify(malformed)}`);
    }
    assert.equal(complete({ ...entry, summary: { ...summary, future: { inert: true } } }), true);
    assert.equal(complete({ ...entry, anchor: [] }), false);
  }
});
