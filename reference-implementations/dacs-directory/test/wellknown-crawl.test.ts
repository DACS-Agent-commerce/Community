import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import test from "node:test";
import { ed25519Sign, privateKeyFromSeed } from "@kynesyslabs/dacs/crypto";
import { contentHash, sha256Hex } from "../src/catalog/canonical.js";
import { indexRegistration } from "../src/catalog/indexer.js";
import { findValidListingRevocation, verifyListing } from "../src/catalog/listingVerification.js";
import { ingestWellKnownRevocations } from "../src/catalog/reindexCore.js";
import { crawlDomain } from "../src/catalog/wellknown.js";
import { dids, locator, seeds } from "./fixtures/current-evidence.js";

const signed = (scope: Record<string, unknown>, domain: string) => ({ ...scope, signature: { algorithm: "ed25519", signer: dids[1],
  value: Buffer.from(ed25519Sign(Buffer.from(`${domain}${contentHash(scope)}`), privateKeyFromSeed(seeds[1]))).toString("base64url") } });

// A legacy Listing whose serviceId is not a DACS-1 URL-safe listingId; the indexer admits it.
const listing = signed({ agentId: dids[1], serviceId: "pr review", name: "PR review", description: "Legacy service",
  claimRequirements: [], supportedNegotiation: ["negotiate-fixed-price"], supportedPaymentRails: ["pay-dem"],
  supportedDelivery: ["deliver-attested-payload"] }, "dacs-listing:v1:");
const verified = await verifyListing(listing);
assert.ok(verified);
const marker = signed({ listingId: "pr review", listingVersion: 1, listingContentHash: verified.contentHash, revokedAt: 1 }, "dacs-revocation:v1:");
const binding = await findValidListingRevocation([locator(2)], verified, 1, async () => marker);
assert.ok(binding);

test("the crawler carries a legacy Listing's withdrawal and the Listing ends revoked", async () => {
  const domain = "https://legacy.example";
  const raw = JSON.stringify({ indexVersion: "1", generatedAt: 1, seller: dids[1], listings: [{
    listingId: "pr review", version: 1, contentHash: verified.contentHash, anchor: { kind: "storage-program", locator: locator(1) },
    summary: { title: "PR review", category: "services.other", tags: [] }, status: "revoked", revocation: binding,
  }] });
  const crawled = await crawlDomain(domain, { validateUrl: async () => ({} as never), fetchJson: async (url) => {
    const text = url.endsWith("agent.json") ? JSON.stringify({ dacs: { dacsVersion: "1", listings: {
      indexUrl: `${domain}/listings.json`, indexHash: `sha256-${sha256Hex(raw)}`,
    } } }) : raw;
    return { raw: text, body: JSON.parse(text) };
  } });
  assert.ok(!("error" in crawled), JSON.stringify(crawled));
  assert.deepEqual(crawled.revocations, [binding]);
  assert.deepEqual(crawled.incompleteWithdrawalHashes, []);

  const originalFetch = globalThis.fetch;
  const storage: Record<string, unknown> = { [locator(1)]: listing, [locator(2)]: marker };
  globalThis.fetch = async (input) => {
    const at = String(input).split("/").pop() ?? "";
    return at in storage ? Response.json({ success: true, owner: `0x${dids[1].slice(-64)}`, data: storage[at] })
      : Response.json({ success: false }, { status: 404 });
  };
  try {
    await ingestWellKnownRevocations(crawled);
    const record = await indexRegistration({ primaryClaim: dids[1], displayName: "seller", listingAnchors: [locator(1)] },
      undefined, async () => { throw new Error("identity unavailable"); });
    assert.deepEqual(record.listings.map((summary) => [summary.listingId, summary.status, summary.revocation]),
      [["pr review", "revoked", binding]]);
  } finally { globalThis.fetch = originalFetch; }
});
