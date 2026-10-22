import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import test from "node:test";
import old from "./fixtures/live-invalid-verification-methods.json";
import { parseListingUpgradeManifest } from "../src/catalog/listingUpgradeManifest.js";

const manifest = () => old.map((listing, index) => ({ sourceListingId: listing.listingId,
  replacementListingId: `${listing.listingId}-replacement`, replacementVersion: 1,
  replacementLocator: `stor-${String(index + 1).repeat(40)}`, supportedPayloadMethods: ["self-signed"],
}));
test("replacement manifest maps every occupied old Listing to a fresh ID, starting at version one", () => {
  assert.deepEqual(parseListingUpgradeManifest(manifest()), manifest());
  const sameId = manifest(); sameId[0].replacementListingId = old[0].listingId;
  assert.throws(() => parseListingUpgradeManifest(sameId), /new Listing ID/);
  const duplicate = manifest(); duplicate[1].sourceListingId = duplicate[0].sourceListingId;
  assert.throws(() => parseListingUpgradeManifest(duplicate), /exactly once/);
  const badVersion = manifest(); badVersion[0].replacementVersion = 0;
  assert.throws(() => parseListingUpgradeManifest(badVersion), /invalid entry/);
});


test("the complete catalog replacement check runs with fresh IDs and unassessed buyer readiness", async () => {
  const { checkListingUpgrades } = await import("../scripts/check-live-listing-upgrade.js");
  const { vector, sign, dids, seeds } = await import("./fixtures/current-evidence.js");
  const { contentHash } = await import("@kynesyslabs/dacs/canonical");
  const fixture = await vector("upgrade-check", 700);
  const entries = manifest();
  const anchors = new Map<string, Record<string, unknown>>();
  const summaries: Record<string, unknown>[] = [];
  for (const [index, entry] of entries.entries()) {
    const { signature: _, ...scope } = fixture.listing;
    const replacementScope = { ...scope, listingId: entry.replacementListingId,
      acceptedRails: [{ railId: "demos-native:DEM" }], pipeline: [
        { kind: "negotiate-fixed-price" }, { kind: "commit-agreement" },
        { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }, { kind: "deliver-attested-payload" },
      ] };
    const replacement = { ...replacementScope, signature: await sign(replacementScope, "listing", 1) };
    anchors.set(entry.replacementLocator, replacement);
    const offering = fixture.listing.offering as Record<string, unknown>;
    anchors.set(old[index].locator, { ...fixture.listing, listingId: old[index].listingId,
      listingVersion: old[index].listingVersion, offering: { ...offering, deliverable: { kind: "attested-payload", verificationMethod: old[index].verificationMethod } } });
    summaries.push({ listingId: entry.replacementListingId, version: 1, contentHash: contentHash(replacement),
      anchor: { locator: entry.replacementLocator }, status: "active", catalogObservedAt: Date.now(), transactionReadiness: { disposition: "unassessed" } });
  }
  const originalFetch = globalThis.fetch;
  const previous = { origin: process.env.NEXT_PUBLIC_DIRECTORY_URL, manifest: process.env.DACS_LISTING_UPGRADE_REPLACEMENTS };
  process.env.NEXT_PUBLIC_DIRECTORY_URL = "https://directory.example";
  process.env.DACS_LISTING_UPGRADE_REPLACEMENTS = JSON.stringify(entries);
  let hideReplacement = false;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/storage-program/")) return Response.json({ success: true, data: anchors.get(url.pathname.split("/").pop()!) });
    if (url.pathname === "/api/dacs/status") return Response.json({ indexer: { listingRejectionDiagnostics: { items: [
      { locator: url.searchParams.get("locator"), code: "VERIFICATION_METHOD_INVALID" },
    ] } } });
    assert.equal(url.searchParams.get("primaryClaim"), dids[1]);
    return Response.json({ listings: hideReplacement ? [] : summaries });
  };
  try {
    const output: string[] = [];
    await checkListingUpgrades((message) => { output.push(message); });
    assert.equal(output.filter((line) => line.includes("authenticated and discoverable")).length, 3);
    assert.equal(output.filter((line) => line.includes("reader remains unassessed")).length, 3);
    summaries[0].status = "revoked";
    await assert.rejects(checkListingUpgrades(() => {}), /required-binding-missing/);
    const markerScope = { listingId: entries[0].replacementListingId, listingVersion: 1,
      listingContentHash: summaries[0].contentHash, revokedAt: 1 };
    const { ed25519Sign, privateKeyFromSeed } = await import("@kynesyslabs/dacs/crypto");
    const marker = { ...markerScope, signature: { algorithm: "ed25519", signer: dids[1],
      value: Buffer.from(ed25519Sign(Buffer.from(`dacs-revocation:v1:${contentHash(markerScope)}`), privateKeyFromSeed(seeds[1]))).toString("base64url") } };
    const markerAt = `stor-${"f".repeat(40)}`;
    anchors.set(markerAt, marker);
    summaries[0].revocation = { sellerPrimaryClaim: dids[1], listingId: entries[0].replacementListingId,
      listingVersion: 1, listingContentHash: summaries[0].contentHash,
      logicalAddress: `dacs1-revoked:${encodeURIComponent(dids[1])}:${entries[0].replacementListingId}:v1`,
      markerAnchor: { kind: "storage-program", locator: markerAt }, markerContentHash: contentHash(marker) };
    await assert.rejects(checkListingUpgrades(() => {}), /verified-revocation-marker/);
    summaries[0].status = "active";
    delete summaries[0].revocation;
    hideReplacement = true;
    await assert.rejects(checkListingUpgrades(() => {}), /not exposed by the reindexed catalog/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.origin === undefined) delete process.env.NEXT_PUBLIC_DIRECTORY_URL; else process.env.NEXT_PUBLIC_DIRECTORY_URL = previous.origin;
    if (previous.manifest === undefined) delete process.env.DACS_LISTING_UPGRADE_REPLACEMENTS; else process.env.DACS_LISTING_UPGRADE_REPLACEMENTS = previous.manifest;
  }
});
