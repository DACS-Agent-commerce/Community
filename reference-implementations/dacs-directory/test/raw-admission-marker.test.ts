import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash } from "../src/catalog/canonical.js";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";

// CORE §B.2 CF-5: a carried withdrawal marker whose received bytes raw admission refuses is not read.
// It stays unresolved and holds the Listing; only a marker that reads and fails RB-4 releases a binding.
const directory = mkdtempSync(join(tmpdir(), "dacs-raw-marker-"));
process.env.DACS_DIRECTORY_DATA = directory;
const { indexRegistration } = await import("../src/catalog/indexer.js");
const { findValidListingRevocation, verifyListing } = await import("../src/catalog/listingVerification.js");
const store = await import("../src/catalog/store.js");
test.after(() => rmSync(directory, { recursive: true, force: true }));
const at = (n: number) => `stor-${String(n).padStart(40, "0")}`;

test("a carried marker refused by raw admission stays unresolved, holds the Listing and releases no binding", async () => {
  const seed = new Uint8Array(32).fill(43);
  const key = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex");
  const claim = `did:demos:agent:${key}`;
  const sign = (raw: Record<string, unknown>, prefix: string) => ({ algorithm: "ed25519", signer: claim,
    value: Buffer.from(ed25519Sign(Buffer.from(prefix + contentHash(raw)), privateKeyFromSeed(seed))).toString("base64url") });
  const identityScope = { bundleVersion: "1", presentedBy: claim, presentedAt: 1, claims: [{ ref: claim }] };
  const identity = { ...identityScope, presentation: { kind: "per-claim", signatures: [{ ref: claim,
    signature: Buffer.from(ed25519Sign(Buffer.from(`dacs-bundle-presentation:v1:${contentHash(identityScope)}`), privateKeyFromSeed(seed))).toString("base64url") }] } };
  const scope = { dacsVersion: "1", listingVersion: 1, listingId: "svc-raw", requiredCapabilities: ["SR-2"],
    seller: { displayName: "Service", identity },
    offering: { title: "Service", description: "Service", category: "services.other", tags: [],
      deliverable: { kind: "attested-payload", payloadFormat: "application/json", verificationMethod: { kind: "self-signed" } } },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "deliver-attested-payload" }],
    pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } }, terms: {}, validity: { notBefore: 1 } };
  const listing = { ...scope, signature: sign(scope, "dacs-listing:v1:") };
  const verified = await verifyListing(listing);
  assert.ok(verified);
  const markerScope = { listingId: "svc-raw", listingVersion: 1, listingContentHash: verified.contentHash, revokedAt: 1 };
  const marker = { ...markerScope, signature: sign(markerScope, "dacs-revocation:v1:") };
  const binding = await findValidListingRevocation([at(2)], verified, 1, async () => marker);
  assert.ok(binding);
  // The same signed marker once the duplicate member is dropped: JSON.parse alone would accept it.
  const refusedMarkerText = JSON.stringify(marker).replace('"revokedAt":1', '"revokedAt":1,"revokedAt":1');
  assert.deepEqual(JSON.parse(refusedMarkerText), marker);
  store.recordWellKnownWithdrawalCheck("seller-raw.example", claim, [verified.contentHash], [], { generatedAt: 1, hash: "a".repeat(64) }, [binding]);

  const oldFetch = globalThis.fetch;
  let markerReply = `{"success":true,"owner":"0x${key}","data":${refusedMarkerText}}`;
  globalThis.fetch = async (input) => new URL(String(input)).pathname.endsWith(at(2))
    ? new Response(markerReply) : Response.json({ success: true, owner: `0x${key}`, data: listing });
  const originalNow = Date.now;
  try {
    const reg = { primaryClaim: claim, displayName: "Service", listingAnchors: [at(1)], deals: [] };
    const index = () => indexRegistration(reg, undefined, async () => { throw new Error("offline"); });
    for (const pass of [0, 1]) {
      Date.now = () => originalNow() + pass * 120_000;
      assert.equal((await index()).listings.length, 0, `pass ${pass}: the Listing stays held`);
      assert.equal(store.boundWellKnownRevocations(claim, verified.contentHash, "svc-raw", 1).length, 1, "the binding is not released");
      assert.equal(store.hasIncompleteWellKnownWithdrawal(claim, verified.contentHash), true);
      assert.equal(store.hasPendingRevocationCandidates(verified.contentHash), true, "the marker is still pending");
    }
    markerReply = `{"success":true,"owner":"0x${key}","data":${JSON.stringify(marker)}}`;
    Date.now = () => originalNow() + 240_000;
    const indexed = await index();
    assert.equal(indexed.listings[0]?.status, "revoked", "only a marker that reads resolves the hold");
    assert.deepEqual(indexed.listings[0].revocation, binding);
  } finally { Date.now = originalNow; globalThis.fetch = oldFetch; }
});
