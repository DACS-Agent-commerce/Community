import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RevocationBinding } from "../src/catalog/types.js";

// Writes a catalog writer makes from node reads are journaled until a chain check confirms them.
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-chain-read-window-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
const store = await import("../src/catalog/store.js");
test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));

const hash = "e".repeat(64);
const newHash = "f".repeat(64);
const binding = (locator: string, listingContentHash = hash): RevocationBinding => ({
  sellerPrimaryClaim: "did:demos:agent:a", listingId: "svc", listingVersion: 1, listingContentHash,
  logicalAddress: "dacs1-revoked:a:svc:v1", markerAnchor: { kind: "storage-program", locator }, markerContentHash: "d".repeat(64),
});
const candidatePending = () => store.hasPendingRevocationCandidates(hash);
const rejections = () => store.indexerDiagnostics().listingRejectionDiagnostics.items.map((item) => [item.locator, item.code]);

/** One write of each kind: a key and a row inserted, a key updated, a row deleted, a candidate and its retry. */
function writeEachKind(): void {
  store.retainListingRevocation(binding("stor-new", newHash), { marker: "new" });
  store.retainListingRevocation(binding("stor-old-updated"), { marker: "updated" });
  store.recordListingRejection("stor-listing-new", "did:demos:agent:a", "SELLER_CLAIM_BINDING");
  store.clearListingRejection("stor-listing-old", "did:demos:agent:a");
  store.admitRevocationCandidates(hash, [{ locator: "stor-candidate-new" }]);
  store.recordRevocationProgress(hash, { unread: ["stor-candidate-new"], rejected: [] });
}
function seed(): void {
  store.clearChainDerivedArtifacts();
  store.retainListingRevocation(binding("stor-old"), { marker: "old" });
  store.recordListingRejection("stor-listing-old", "did:demos:agent:a", "OWNER_CLAIM_BINDING");
}

test("a reverted window restores every journaled table and keeps registrations and domains written meanwhile", async () => {
  seed();
  store.openChainReadWindow();
  writeEachKind();
  store.saveRegistrations([{ primaryClaim: "did:demos:agent:b", displayName: "Registered meanwhile", listingAnchors: [] }]);
  store.saveDomains(["registered-meanwhile.example"]);
  store.revertChainReadWindow();
  assert.equal(store.retainedListingRevocation(hash)?.markerAnchor.locator, "stor-old");
  assert.equal(store.retainedListingRevocation(newHash), null);
  assert.deepEqual(rejections(), [["stor-listing-old", "OWNER_CLAIM_BINDING"]]);
  assert.equal(candidatePending(), false);
  assert.equal(store.loadRegistrations()[0]?.displayName, "Registered meanwhile");
  assert.deepEqual(store.loadDomains(), ["registered-meanwhile.example"]);
});

test("a confirmed window keeps its writes, and a later revert undoes nothing", () => {
  seed();
  store.openChainReadWindow();
  writeEachKind();
  store.confirmChainReadWindow();
  store.revertChainReadWindow();
  assert.equal(store.retainedListingRevocation(hash)?.markerAnchor.locator, "stor-old-updated");
  assert.equal(store.retainedListingRevocation(newHash)?.markerAnchor.locator, "stor-new");
  assert.deepEqual(rejections(), [["stor-listing-new", "SELLER_CLAIM_BINDING"]]);
  assert.equal(candidatePending(), true);
});

test("writes outside a window are not journaled", () => {
  seed();
  writeEachKind();
  store.revertChainReadWindow();
  assert.equal(store.retainedListingRevocation(hash)?.markerAnchor.locator, "stor-old-updated");
});

test("a reverted window keeps the publisher-signed withdrawal sources saved inside it", () => {
  const seller = "did:demos:agent:a";
  const source = "https://signed-source.example";
  store.saveDomains([source]);
  const revisionBefore = store.wellKnownWithdrawalRevision();
  store.openChainReadWindow();
  store.recordWellKnownWithdrawalCheck(source, seller, [], [], { generatedAt: 5, hash: "c".repeat(64) },
    [], "publisher-signature", { "stor-declared": newHash });
  store.recordListingRejection("stor-listing-in-window", seller, "SELLER_CLAIM_BINDING");
  store.revertChainReadWindow();
  assert.deepEqual(store.savedListingDeclarations(seller).sources, [{ "stor-declared": newHash }]);
  assert.equal(store.wellKnownWithdrawalRevision(), revisionBefore + 1);
  assert.equal(rejections().some(([locator]) => locator === "stor-listing-in-window"), false, "what the node's reads produced is still undone");
});
