import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ed25519Sign, privateKeyFromSeed } from "@kynesyslabs/dacs/crypto";
import { contentHash, sha256Hex } from "../src/catalog/canonical.js";
import { findValidListingRevocation, revocationLogicalAddress, verifyListing } from "../src/catalog/listingVerification.js";
import { crawlDomain, listingIndexEntryIsComplete, type WellKnownAgent } from "../src/catalog/wellknown.js";
import { indexRegistration } from "../src/catalog/indexer.js";
import { ingestWellKnownRevocations, reindexAll } from "../src/catalog/reindexCore.js";
import {
  hasIncompleteWellKnownWithdrawal, loadCatalog, recordWellKnownWithdrawalCheck, retainedListingRevocation, saveDomains,
  saveRegistrations,
} from "../src/catalog/store.js";
import { dids, locator, seeds, vector } from "./fixtures/current-evidence.js";

const presentedBy = `${dids[1]}?channel=directory`;
const { listing } = await vector("qualified-withdrawal", 0, presentedBy);
const verified = await verifyListing(listing);
assert.ok(verified);
const tuple = { listingId: "svc", listingVersion: 1, listingContentHash: verified.contentHash, revokedAt: 1 };
const marker = { ...tuple, signature: { algorithm: "ed25519", signer: dids[1],
  value: Buffer.from(ed25519Sign(Buffer.from(`dacs-revocation:v1:${contentHash(tuple)}`), privateKeyFromSeed(seeds[1]))).toString("base64url") } };
const binding = await findValidListingRevocation([locator(2)], verified, 1, async () => marker);
assert.ok(binding);
const row = { listingId: "svc", version: 1, contentHash: verified.contentHash,
  anchor: { kind: "storage-program", locator: locator(1) },
  summary: { title: "Service", category: "services.other", tags: [] }, status: "revoked", revocation: binding };
const agent: WellKnownAgent = { domain: "https://qualified.example", seller: dids[1], listingAnchors: [locator(1)],
  activeListingAnchors: [], contentHashes: { [locator(1)]: verified.contentHash }, revocations: [binding], bundleBindings: [] };

test("qualified withdrawal discovery compares identities and keeps the exact publisher logical address", async () => {
  assert.equal(binding.sellerPrimaryClaim, presentedBy);
  assert.equal(binding.logicalAddress, revocationLogicalAddress(presentedBy, "svc", 1));
  assert.equal(listingIndexEntryIsComplete(row, dids[1]), true);
  for (const changed of [
    { sellerPrimaryClaim: dids[0] }, { sellerPrimaryClaim: null }, { sellerPrimaryClaim: 7 },
    { sellerPrimaryClaim: `${dids[1]}?channel=%ZZ` },
    { logicalAddress: revocationLogicalAddress(dids[1], "svc", 1) },
  ]) assert.equal(listingIndexEntryIsComplete({ ...row, revocation: { ...binding, ...changed } }, dids[1]), false);
  const raw = JSON.stringify({ indexVersion: "1", generatedAt: 1, seller: dids[1], listings: [row] });
  const crawled = await crawlDomain(agent.domain, { validateUrl: async () => ({} as never), fetchJson: async url => {
    const text = url.endsWith("agent.json") ? JSON.stringify({ dacs: { dacsVersion: "1", listings: {
      indexUrl: `${agent.domain}/listings.json`, indexHash: `sha256-${sha256Hex(raw)}`,
    } } }) : raw;
    return { raw: text, body: JSON.parse(text) };
  } });
  assert.ok(!("error" in crawled));
  assert.deepEqual(crawled.revocations, [binding]);
  assert.deepEqual(crawled.incompleteWithdrawalHashes, []);
});

test("unsigned qualified withdrawal carriage is verified and survives restart with an unreadable marker", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => Response.json({ success: true, owner: `0x${dids[1].slice(-64)}`,
    data: String(input).endsWith(locator(1)) ? listing : marker });
  try {
    const mismatched = { ...binding, sellerPrimaryClaim: dids[1], logicalAddress: revocationLogicalAddress(dids[1], "svc", 1) };
    await ingestWellKnownRevocations({ ...agent, revocations: [mismatched] });
    assert.equal(retainedListingRevocation(verified.contentHash), null, "identity equality alone cannot replace exact presentedBy");
    await ingestWellKnownRevocations(agent);
    assert.deepEqual(retainedListingRevocation(verified.contentHash), binding);
    const restarted = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { ingestWellKnownRevocations } from './src/catalog/reindexCore.ts';
      import { retainedListingRevocation } from './src/catalog/store.ts';
      globalThis.fetch = async input => String(input).endsWith(${JSON.stringify(locator(1))})
        ? Response.json({success:true, owner:${JSON.stringify(`0x${dids[1].slice(-64)}`)}, data:${JSON.stringify(listing)}})
        : Response.json({success:false}, {status:503});
      await ingestWellKnownRevocations(${JSON.stringify(agent)});
      assert.deepEqual(retainedListingRevocation(${JSON.stringify(verified.contentHash)}), ${JSON.stringify(binding)});
    `], { encoding: "utf8", env: process.env });
    assert.equal(restarted.status, 0, restarted.stderr);
  } finally { globalThis.fetch = originalFetch; }
});

const offline = async (): Promise<never> => { throw new Error("identity unavailable"); };
/** Serve storage programs from `storage` as the seller's, and answer every node RPC with no transactions. */
const serveChain = (storage: Record<string, unknown>) => {
  globalThis.fetch = async (input, init) => {
    if (init?.body) return Response.json({ result: 200, response: [] });
    const at = String(input).split("/").pop() ?? "";
    return at in storage ? Response.json({ success: true, owner: `0x${dids[1].slice(-64)}`, data: storage[at] })
      : Response.json({ success: false }, { status: 404 });
  };
};

test("a carried qualified binding whose marker is rejected releases its hold and the Listing is summarised", async () => {
  const carriedBy = `${dids[1]}?channel=carried`;
  const { listing: carriedListing } = await vector("qualified-carried", 0, carriedBy);
  const carried = await verifyListing(carriedListing);
  assert.ok(carried);
  // An authenticated source carries a binding whose marker withdraws another Listing.
  const carriedBinding = { ...binding, sellerPrimaryClaim: carriedBy, listingContentHash: carried.contentHash,
    logicalAddress: revocationLogicalAddress(carriedBy, "svc", 1), markerAnchor: { kind: "storage-program" as const, locator: locator(3) } };
  recordWellKnownWithdrawalCheck("carried.example", dids[1], [carried.contentHash], [], { generatedAt: 1, hash: "a".repeat(64) },
    [carriedBinding], "operator-pin");
  assert.equal(hasIncompleteWellKnownWithdrawal(dids[1], carried.contentHash), true);
  const originalFetch = globalThis.fetch;
  serveChain({ [locator(1)]: carriedListing, [locator(3)]: marker });
  try {
    const record = await indexRegistration({ primaryClaim: dids[1], displayName: "seller", listingAnchors: [locator(1)] }, undefined, offline);
    assert.equal(hasIncompleteWellKnownWithdrawal(dids[1], carried.contentHash), false, "the rejected binding is released");
    assert.deepEqual(record.listings.map((summary) => [summary.seller.primaryClaim, summary.status]), [[carriedBy, "active"]]);
  } finally { globalThis.fetch = originalFetch; }
});

test("a retained qualified binding re-attaches its crawled anchor in a full reindex", async () => {
  const retainedBy = `${dids[1]}?channel=retained`;
  const { listing: retainedListing } = await vector("qualified-retained", 0, retainedBy);
  const retained = await verifyListing(retainedListing);
  assert.ok(retained);
  const scope = { listingId: "svc", listingVersion: 1, listingContentHash: retained.contentHash, revokedAt: 1 };
  const retainedMarker = { ...scope, signature: { algorithm: "ed25519", signer: dids[1],
    value: Buffer.from(ed25519Sign(Buffer.from(`dacs-revocation:v1:${contentHash(scope)}`), privateKeyFromSeed(seeds[1]))).toString("base64url") } };
  const retainedBinding = await findValidListingRevocation([locator(5)], retained, 1, async () => retainedMarker);
  assert.ok(retainedBinding);
  // An unsigned source lists the anchor only as withdrawal carriage.
  const crawled: WellKnownAgent = { domain: "https://retained.example", seller: dids[1], listingAnchors: [locator(4)],
    activeListingAnchors: [], contentHashes: { [locator(4)]: retained.contentHash }, revocations: [retainedBinding], bundleBindings: [] };
  const originalFetch = globalThis.fetch;
  serveChain({ [locator(4)]: retainedListing, [locator(5)]: retainedMarker });
  try {
    saveRegistrations([]);
    saveDomains([crawled.domain]);
    await reindexAll({ log: () => {}, resolveIdentities: offline, crawlWellKnown: async () => ({ agents: [crawled], errors: [] }) });
    const summary = loadCatalog().sellers.flatMap((seller) => seller.listings).find((listing) => listing.contentHash === retained.contentHash);
    assert.deepEqual([summary?.seller.primaryClaim, summary?.status, summary?.revocation], [retainedBy, "revoked", retainedBinding]);
  } finally { globalThis.fetch = originalFetch; }
});
