import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("a reverted window keeps seller-signed Listing preparations saved inside it", () => {
  const preparation = { anchorAddress: "stor-seller-write", transactionJson: '{"signed":"seller-write"}' };
  store.openChainReadWindow();
  assert.equal(store.saveListingPreparation("chain-a", "seller-write:v1", preparation), true);
  store.revertChainReadWindow();
  assert.deepEqual(store.loadListingPreparation("chain-a", "seller-write:v1"), preparation);
});

test("a confirmed window keeps its writes, and a later revert undoes nothing", () => {
  seed();
  store.openChainReadWindow();
  writeEachKind();
  store.commitChainReadWindow(() => {});
  store.revertChainReadWindow();
  assert.equal(store.retainedListingRevocation(hash)?.markerAnchor.locator, "stor-old-updated");
  assert.equal(store.retainedListingRevocation(newHash)?.markerAnchor.locator, "stor-new");
  assert.deepEqual(rejections(), [["stor-listing-new", "SELLER_CLAIM_BINDING"]]);
  assert.equal(candidatePending(), true);
});

test("a commit whose last saves fail keeps none of the window's writes", () => {
  seed();
  const catalog = store.loadCatalog();
  store.openChainReadWindow();
  writeEachKind();
  assert.throws(() => store.commitChainReadWindow(() => {
    store.saveCatalog({ ...catalog, generatedAt: catalog.generatedAt + 1 });
    throw new Error("the last save failed");
  }), /the last save failed/);
  store.revertChainReadWindow();
  assert.deepEqual(store.loadCatalog(), catalog);
  assert.equal(store.retainedListingRevocation(hash)?.markerAnchor.locator, "stor-old");
  assert.equal(store.retainedListingRevocation(newHash), null);
  assert.deepEqual(rejections(), [["stor-listing-old", "OWNER_CLAIM_BINDING"]]);
  assert.equal(candidatePending(), false);
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

// A marker read that rejects a publisher-signed binding's marker releases that binding. The release is
// node-derived: a refused or crashed window must leave the binding holding the Listing.
const signedSeller = "did:demos:agent:a";
/** A publisher-signed source at `domain` carrying a binding for `listingHash`, its marker queued. Returns the binding. */
function signedBindingFor(domain: string, listingHash: string): RevocationBinding {
  const signed = binding(`stor-marker-${listingHash.slice(0, 8)}`, listingHash);
  store.recordWellKnownWithdrawalCheck(domain, signedSeller, [listingHash], [], { generatedAt: 1, hash: "c".repeat(64) }, [signed]);
  store.admitRevocationCandidates(listingHash, [{ locator: signed.markerAnchor.locator }]);
  return signed;
}
const boundCount = (listingHash: string) => store.boundWellKnownRevocations(signedSeller, listingHash, "svc", 1).length;
const rejectMarker = (signed: RevocationBinding) => store.recordRevocationProgress(signed.listingContentHash,
  { unread: [], rejected: [signed.markerAnchor.locator] }, [signed], store.wellKnownWithdrawalRevision());

test("a reverted window keeps a signed binding that a marker rejection inside it released", () => {
  const listingHash = "1".repeat(64);
  const signed = signedBindingFor("https://reverted-release.example", listingHash);
  const revision = store.wellKnownWithdrawalRevision();
  store.openChainReadWindow();
  rejectMarker(signed);
  assert.equal(boundCount(listingHash), 0, "the pass itself reads the binding as released");
  store.revertChainReadWindow();
  assert.equal(boundCount(listingHash), 1);
  assert.equal(store.wellKnownWithdrawalRevision(), revision);
  assert.equal(store.hasPendingRevocationCandidates(listingHash), true);
});

test("a confirmed window releases the binding its marker rejection released", () => {
  const listingHash = "2".repeat(64);
  const signed = signedBindingFor("https://confirmed-release.example", listingHash);
  const revision = store.wellKnownWithdrawalRevision();
  store.openChainReadWindow();
  rejectMarker(signed);
  store.commitChainReadWindow(() => {});
  store.revertChainReadWindow();
  assert.equal(boundCount(listingHash), 0);
  assert.equal(store.wellKnownWithdrawalRevision(), revision + 1);
});

test("a release decided before a newer signed source update in the same window is not applied", () => {
  const listingHash = "3".repeat(64);
  const domain = "https://updated-source.example";
  const signed = signedBindingFor(domain, listingHash);
  store.openChainReadWindow();
  rejectMarker(signed);
  store.recordWellKnownWithdrawalCheck(domain, signedSeller, [listingHash], [], { generatedAt: 2, hash: "c".repeat(64) }, []);
  store.commitChainReadWindow(() => {});
  assert.equal(boundCount(listingHash), 1, "the stale release waits for a read against the newer source");
});

test("a writer reverting a window a crash left open restores the binding its marker rejection released", () => {
  const listingHash = "4".repeat(64);
  const signed = signedBindingFor("https://crashed-release.example", listingHash);
  // The crashed process stages the release and exits before its commit.
  const crashed = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    const store = await import(${JSON.stringify(new URL("../src/catalog/store.ts", import.meta.url).href)});
    const signed = ${JSON.stringify(signed)};
    store.openChainReadWindow();
    store.recordRevocationProgress(signed.listingContentHash, { unread: [], rejected: [signed.markerAnchor.locator] },
      [signed], store.wellKnownWithdrawalRevision());
    process.exit(0);
  `], { encoding: "utf8", timeout: 60_000 });
  assert.equal(crashed.status, 0, crashed.stderr.slice(-2_000));
  assert.equal(boundCount(listingHash), 0, "the crashed window's release is visible until it is reverted");
  store.revertChainReadWindow();
  assert.equal(boundCount(listingHash), 1);
});

const CACHED_ARTIFACTS = 1_000;
const CACHED_ARTIFACT_CHARACTERS = 120_000;
const RECOVERY_HEAP_MEGABYTES = 128;

test("recovering a journal that holds many large prior rows needs memory for one row, not for all of them", () => {
  const recoveryDirectory = mkdtempSync(join(tmpdir(), "dacs-chain-read-window-heap-"));
  try {
    // Earlier passes cached large artifacts; a later pass replaces each with a small row, so every undo
    // statement carries a large prior value. The same process then reverts the window under a small heap.
    const recovery = spawnSync(process.execPath, [`--max-old-space-size=${RECOVERY_HEAP_MEGABYTES}`, "--import", "tsx", "--input-type=module", "-e", `
      import Database from "better-sqlite3";
      import { join } from "node:path";
      const store = await import(${JSON.stringify(new URL("../src/catalog/store.ts", import.meta.url).href)});
      const artifact = (index, data) => ({ locator: "stor-cached-" + index, kind: "listing", profile: "p", observedAt: 1, contentHash: data ? "a".repeat(64) : undefined, data });
      for (let index = 0; index < ${CACHED_ARTIFACTS}; index++) store.recordArtifact(artifact(index, { body: "x".repeat(${CACHED_ARTIFACT_CHARACTERS}) }));
      store.openChainReadWindow();
      for (let index = 0; index < ${CACHED_ARTIFACTS}; index++) store.recordArtifact(artifact(index));
      store.revertChainReadWindow();
      const check = new Database(join(process.env.DACS_DIRECTORY_DATA, "directory.sqlite"), { readonly: true });
      const restored = check.prepare("SELECT COUNT(*) count FROM artifacts WHERE length(data_json) > ${CACHED_ARTIFACT_CHARACTERS}").get().count;
      const journaled = check.prepare("SELECT COUNT(*) count FROM unconfirmed_chain_writes").get().count;
      console.log(JSON.stringify({ restored, journaled }));
    `], { encoding: "utf8", timeout: 120_000, env: { ...process.env, DACS_DIRECTORY_DATA: recoveryDirectory } });
    assert.equal(recovery.status, 0, recovery.stderr.slice(-2_000));
    assert.deepEqual(JSON.parse(recovery.stdout.trim().split("\n").pop() ?? ""), { restored: CACHED_ARTIFACTS, journaled: 0 });
  } finally {
    rmSync(recoveryDirectory, { recursive: true, force: true });
  }
});
