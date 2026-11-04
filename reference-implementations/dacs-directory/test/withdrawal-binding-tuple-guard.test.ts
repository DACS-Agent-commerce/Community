import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import test from "node:test";
import { ed25519Sign, privateKeyFromSeed } from "@kynesyslabs/dacs/crypto";
import { contentHash } from "../src/catalog/canonical.js";
import { canonicalDemosAgentClaim, canonicalDemosAgentReference } from "../src/catalog/claimRef.js";
import { findValidListingRevocation, verifyListing } from "../src/catalog/listingVerification.js";
import type { WellKnownAgent } from "../src/catalog/wellknown.js";
import { ingestWellKnownRevocations } from "../src/catalog/reindexCore.js";
import { hasPendingRevocationCandidates, retainedListingRevocation } from "../src/catalog/store.js";
import { dids, locator, seeds, vector } from "./fixtures/current-evidence.js";

// #147: ingestWellKnownRevocations compares a carried binding's (seller, hash,
// id, version) tuple with the verified Listing before the binding can enter
// the bounded revocation-candidate queue. A binding whose tuple names another
// Listing, but which carries the same marker anchor and logical address, is
// the case only that guard rejects: the later marker comparison would accept it.

const presentedBy = `${dids[1]}?channel=tuple-guard`;
const otherChannel = `${dids[1]}?channel=other`;
// Both references identify the same CF-3 party, but differ in CF-2 reference bytes.
assert.equal(canonicalDemosAgentClaim(otherChannel), canonicalDemosAgentClaim(presentedBy));
assert.equal(canonicalDemosAgentClaim(dids[1]), canonicalDemosAgentClaim(presentedBy));
assert.equal(canonicalDemosAgentReference(otherChannel), otherChannel);
assert.equal(canonicalDemosAgentReference(dids[1]), dids[1]);
const { listing } = await vector("tuple-guard", 0, presentedBy);
const verified = await verifyListing(listing);
assert.ok(verified);
const scope = { listingId: "svc", listingVersion: 1, listingContentHash: verified.contentHash, revokedAt: 1 };
const marker = { ...scope, signature: { algorithm: "ed25519", signer: dids[1],
  value: Buffer.from(ed25519Sign(Buffer.from(`dacs-revocation:v1:${contentHash(scope)}`), privateKeyFromSeed(seeds[1]))).toString("base64url") } };
const binding = await findValidListingRevocation([locator(2)], verified, 1, async () => marker);
assert.ok(binding);
assert.equal(binding.listingId, "svc");
assert.equal(binding.listingVersion, 1);
assert.equal(binding.sellerPrimaryClaim, presentedBy);

const agentFor = (revocations: WellKnownAgent["revocations"]): WellKnownAgent => ({
  domain: "https://tuple-guard.example", seller: dids[1], listingAnchors: [locator(1)], activeListingAnchors: [],
  contentHashes: { [locator(1)]: verified.contentHash }, revocations, bundleBindings: [],
});

/** Serve the Listing at locator(1) and the marker at locator(2) as the seller's. */
const serve = () => {
  globalThis.fetch = async (input) => {
    const at = String(input).split("/").pop() ?? "";
    const data = at === locator(1) ? listing : at === locator(2) ? marker : null;
    return data ? Response.json({ success: true, owner: `0x${dids[1].slice(-64)}`, data })
      : Response.json({ success: false }, { status: 404 });
  };
};

test("a carried binding whose tuple names another Listing never enters the candidate queue", async () => {
  const originalFetch = globalThis.fetch;
  serve();
  try {
    const foreign: Array<[string, Partial<typeof binding>]> = [
      ["seller", { sellerPrimaryClaim: `${dids[2]}?channel=tuple-guard` }],
      // #250: the same key under other CF-2 parameters, and the bare DID. Both are
      // the publisher's CF-3 party, but the binding's seller must equal the
      // publisher's exact reference (RB-2, kept exact on #179); a guard that
      // compares CF-3 identities would admit both.
      ["seller-cf3-other-channel", { sellerPrimaryClaim: otherChannel }],
      ["seller-cf3-bare-did", { sellerPrimaryClaim: dids[1] }],
      ["listingId", { listingId: "other" }],
      ["listingVersion", { listingVersion: 2 }],
      ["listingContentHash", { listingContentHash: "f".repeat(64) }],
    ];
    for (const [field, change] of foreign) {
      // Only the named field differs; the marker anchor and logical address
      // still match the marker the node serves, so the later marker comparison
      // alone would admit it.
      await ingestWellKnownRevocations(agentFor([{ ...binding, ...change }]));
      assert.equal(hasPendingRevocationCandidates(verified.contentHash), false, `${field}: no candidate queued`);
      assert.equal(retainedListingRevocation(verified.contentHash), null, `${field}: no marker retained`);
    }
    // Control: the exact tuple is admitted and its marker retained.
    await ingestWellKnownRevocations(agentFor([binding]));
    assert.equal(hasPendingRevocationCandidates(verified.contentHash), true);
    assert.deepEqual(retainedListingRevocation(verified.contentHash), binding);
  } finally { globalThis.fetch = originalFetch; }
});

test("in one pass the exact binding is admitted beside the foreign ones", async () => {
  // The guard rejects per binding, not per source: a source carrying three
  // foreign tuples and the exact one still gets the exact one admitted.
  const mixedBy = `${dids[1]}?channel=tuple-guard-mixed`;
  const { listing: mixedListing } = await vector("tuple-guard-mixed", 0, mixedBy);
  const mixed = await verifyListing(mixedListing);
  assert.ok(mixed);
  const mixedScope = { ...scope, listingContentHash: mixed.contentHash };
  const mixedMarker = { ...mixedScope, signature: { algorithm: "ed25519", signer: dids[1],
    value: Buffer.from(ed25519Sign(Buffer.from(`dacs-revocation:v1:${contentHash(mixedScope)}`), privateKeyFromSeed(seeds[1]))).toString("base64url") } };
  const exact = await findValidListingRevocation([locator(4)], mixed, 1, async () => mixedMarker);
  assert.ok(exact);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const at = String(input).split("/").pop() ?? "";
    const data = at === locator(3) ? mixedListing : at === locator(4) ? mixedMarker : null;
    return data ? Response.json({ success: true, owner: `0x${dids[1].slice(-64)}`, data })
      : Response.json({ success: false }, { status: 404 });
  };
  try {
    await ingestWellKnownRevocations({
      domain: "https://tuple-guard-mixed.example", seller: dids[1], listingAnchors: [locator(3)], activeListingAnchors: [],
      contentHashes: { [locator(3)]: mixed.contentHash }, bundleBindings: [],
      revocations: [
        { ...exact, sellerPrimaryClaim: `${dids[2]}?channel=tuple-guard-mixed` },
        { ...exact, listingId: "other" },
        { ...exact, listingVersion: 2 },
        exact,
      ],
    });
    assert.equal(hasPendingRevocationCandidates(mixed.contentHash), true);
    assert.deepEqual(retainedListingRevocation(mixed.contentHash), exact);
  } finally { globalThis.fetch = originalFetch; }
});
