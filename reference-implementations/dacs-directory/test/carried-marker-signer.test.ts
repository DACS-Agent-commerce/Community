import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { canonicalize, contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { kitSeller, type KitSeller } from "./fixtures/kit-listing.js";
import { onPinnedChain } from "./fixtures/pinned-node.js";

// A dacs-v0.1 Listing presented by O (its anchor owner) can be signed by another claim key K in
// its identity bundle. A marker K signed and carried in K's own confirmed CREATE holds that
// Listing while the marker's storage cannot be read, and revokes it once it reads.
const root = mkdtempSync(join(tmpdir(), "dacs-carried-signer-"));
process.env.DACS_DIRECTORY_DATA = root;
const store = await import("../src/catalog/store.js");
const { seedScanState } = await import("./fixtures/chain-state.js");
const { PINNED_DEMOS_CHAIN_IDENTITY } = await import("../src/catalog/nodeDeployment.js");
const { deriveStorageAddress } = await import("../src/catalog/chain.js");
const { reindexAll } = await import("../src/catalog/reindexCore.js");
const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); });

const O = kitSeller(41), K = kitSeller(42);
const anchor = `stor-${"a".repeat(40)}`;
let nonce = 0;

function twoClaimListing(listingSigner: KitSeller, listingId: string) {
  const notBefore = Date.now() - 60_000;
  const bundle = { bundleVersion: "1", presentedBy: O.claim, presentedAt: notBefore - 1000,
    sessionNonce: sha256Hex(`carried:${listingId}`), claims: [{ ref: O.claim }, { ref: K.claim }] };
  const bundleHash = sha256Hex(canonicalize(bundle));
  const identity = { ...bundle, presentation: { kind: "per-claim", signatures: [
    { ref: O.claim, signature: O.sign("dacs-bundle-presentation:v1:", bundleHash) },
    { ref: K.claim, signature: K.sign("dacs-bundle-presentation:v1:", bundleHash) }] } };
  const draft = {
    dacsVersion: "1", listingVersion: 1, listingId, requiredCapabilities: ["SR-1", "SR-2"],
    seller: { identity, displayName: "Two claims", publicEndpoint: "https://seller.example.org/agent" },
    offering: { title: "Two-claim report", description: "public synthetic", category: "services.market-report", tags: ["test"],
      deliverable: { kind: "storage-program", schemaUrl: "urn:dacs-chatgpt-plugin:v0.1:seller-defined-delivery", accessModel: "public" } },
    buyerRequirement: { requirementVersion: "1", required: [], preferredPresentation: "any" },
    pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-payee-bound-agreement" },
      { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }, { kind: "deliver-storage-program" }],
    pricing: { kind: "fixed", price: { amount: "2.5", currency: "DEM" } },
    acceptedRails: [{ railId: "demos-native:DEM", railVersion: 1 }],
    terms: { deadlineSecAfterCommit: 3600, cancellationPolicy: "pre-commit", transcriptDisclosurePolicy: "encrypted-anchored-recommended" },
    validity: { notBefore },
  };
  const hash = contentHash(draft);
  const listing = { ...draft, signature: { algorithm: "ed25519", signer: listingSigner.claim,
    value: listingSigner.sign("dacs-listing:v1:", hash) } };
  const scope = { listingId, listingVersion: 1, listingContentHash: hash, revokedAt: 1 };
  const marker = { ...scope, signature: { algorithm: "ed25519", signer: K.claim, value: K.sign("dacs-revocation:v1:", contentHash(scope)) } };
  return { listing, hash, marker };
}

/**
 * First pass: K's CREATE carries the marker (unless `carried` is false: the page then has no CREATE)
 * and its storage replies `firstReply`; `recover` then serves the marker.
 */
async function carriedPass(listingSigner: KitSeller, firstReply: "503" | "empty-object", carried = true) {
  const { listing, hash, marker } = twoClaimListing(listingSigner, `two-claim-${++nonce}`);
  const programName = "dacs1-revoked:two-claim";
  const markerRef = deriveStorageAddress(K.owner, programName, 100 + nonce, "");
  const content = JSON.stringify({ type: "storageProgram", from: K.owner, to: markerRef, amount: 0, nonce: 100 + nonce, timestamp: 1,
    data: ["storageProgram", { operation: "CREATE_STORAGE_PROGRAM", storageAddress: markerRef, programName, encoding: "json",
      data: marker, acl: { mode: "public" }, salt: "", storageLocation: "onchain" }] });
  const tx = { id: 3, to: markerRef, status: "confirmed", type: "storageProgram", blockNumber: 3, hash: "ab".repeat(32), content };
  seedScanState({ schemaVersion: 10, chainIdentity: PINNED_DEMOS_CHAIN_IDENTITY, lastSeenTxId: 0, listings: {}, deals: {} });
  store.saveRegistrations([{ primaryClaim: O.claim, displayName: "two claims", listingAnchors: [anchor] }]);
  let recovered = false;
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") return Response.json({ result: 200, response: [{ id: 5 }, { id: 4 }, ...(carried ? [tx] : []), { id: 2 }, { id: 1 }] });
    const at = String(input).split("/").at(-1);
    if (at === anchor) return Response.json({ success: true, owner: O.owner, programName: "dacs1:listing:two-claim", data: listing });
    if (at === markerRef && recovered) return Response.json({ success: true, owner: K.owner, programName, data: marker });
    if (at === markerRef && firstReply === "empty-object") return Response.json({ success: true, owner: K.owner, programName, data: {} });
    return new Response("", { status: 503 });
  };
  const opts = { nodeDeployment: onPinnedChain, resolveIdentities: async () => ({}), log: () => {} };
  const row = () => store.loadCatalog().sellers.flatMap((seller) => seller.listings).find((entry) => entry.contentHash === hash);
  const due = () => {
    const db = new Database(join(root, "directory.sqlite"));
    // Test-only: make the artifact and candidate retries due now instead of after their backoff.
    try {
      db.prepare("UPDATE artifacts SET status='retry',next_retry_at=0 WHERE locator=?").run(markerRef);
      db.prepare("DELETE FROM revocation_candidate_retries WHERE locator=?").run(markerRef);
    } finally { db.close(); }
    store.saveScanState({ ...store.loadScanState(), lastSeenTxId: 10 });
  };
  await reindexAll(opts);
  return {
    first: row(),
    again: async () => { due(); await reindexAll(opts); return row(); },
    recover: async () => { due(); recovered = true; await reindexAll(opts); return row(); },
  };
}

test("a marker carried by the listing's signing key holds it when another key owns the anchor, then revokes it", async () => {
  const pass = await carriedPass(K, "503");
  assert.equal(pass.first, undefined, "held, not published active");
  const after = await pass.recover();
  assert.equal(after?.status, "revoked");
  assert.ok(after?.revocation);
});

test("a {} reply leaves the signing key's carried marker unread, pass after pass", async () => {
  const pass = await carriedPass(K, "empty-object");
  assert.equal(pass.first, undefined);
  assert.equal(await pass.again(), undefined, "the indexer's {} read does not settle it");
  assert.equal((await pass.recover())?.status, "revoked");
});

test("a key that is only a claim in the bundle, and did not sign the listing, cannot hold it", async () => {
  const pass = await carriedPass(O, "503");
  assert.equal(pass.first?.status, "active");
});

test("the signing key's Listing with no carried marker is published active", async () => {
  // #230: the baseline for the first two tests. With no CREATE on the page, nothing holds a
  // Listing K signed, so the hold they see comes from K's carried marker, not from K signing.
  // K's marker for another of its Listings is left unread first: it must not hold this one.
  assert.equal((await carriedPass(K, "503")).first, undefined, "the other Listing is held");
  const pass = await carriedPass(K, "503", false);
  assert.equal(pass.first?.status, "active");
  assert.equal(pass.first?.revocation, undefined);
});
