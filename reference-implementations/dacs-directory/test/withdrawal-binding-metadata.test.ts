import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { contentHash, sha256Hex } from "../src/catalog/canonical.js";
import { crawlDomain } from "../src/catalog/wellknown.js";
import { findValidListingRevocation, verifyListing } from "../src/catalog/listingVerification.js";

const directory = mkdtempSync(join(tmpdir(), "dacs-binding-metadata-"));
process.env.DACS_DIRECTORY_DATA = directory;
const store = await import("../src/catalog/store.js");
const { reindexAll } = await import("../src/catalog/reindexCore.js");
const { activeOffer } = await import("../src/catalog/discovery.js");
test.after(() => rmSync(directory, { recursive: true, force: true }));
const at = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;
const summary = { title: "Service", category: "services.other", tags: [] };

test("verified withdrawal bindings survive incomplete discovery metadata without creating new offers", async t => {
  const seed = new Uint8Array(32).fill(41);
  const key = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex");
  const claim = `did:demos:agent:${key}`;
  const sign = (scope: Record<string, unknown>, prefix: string) => ({ algorithm: "ed25519", signer: claim,
    value: Buffer.from(ed25519Sign(Buffer.from(prefix + contentHash(scope)), privateKeyFromSeed(seed))).toString("base64url") });
  const identityScope = { bundleVersion: "1", presentedBy: claim, presentedAt: 1, claims: [{ ref: claim }] };
  const identity = { ...identityScope, presentation: { kind: "per-claim", signatures: [{ ref: claim,
    signature: Buffer.from(ed25519Sign(Buffer.from(`dacs-bundle-presentation:v1:${contentHash(identityScope)}`),
      privateKeyFromSeed(seed))).toString("hex") }] } };
  const cases: Array<[string, Record<string, unknown>]> = [
    ["complete control", {}],
    ["tampered marker control", { summary: undefined }],
    ...[undefined, null, [], "summary", {}, { ...summary, title: 7 }, { ...summary, category: null },
      { ...summary, tags: "service" }, { ...summary, tags: [7] }, { ...summary, priceHint: 7 }]
      .map((value, i): [string, Record<string, unknown>] => [`malformed summary ${i}`, { summary: value }]),
    ...["active", undefined, null, "unknown"]
      .map((status): [string, Record<string, unknown>] => [`inconsistent status ${status}`, { status }]),
    ["missing anchor kind", { anchor: { locator: at(1) } }],
    ["unknown anchor kind", { anchor: { kind: "unknown", locator: at(1) } }],
  ];
  let generatedAt = 0;
  for (const pinned of [false, true]) for (const [name, overrides] of cases) await t.test(`${pinned ? "pinned" : "unsigned"}: ${name}`, async () => {
    const listingId = `metadata-${++generatedAt}`; // Distinct hashes prevent retained state masking another case.
    const scope = { dacsVersion: "1", listingVersion: 1, listingId, requiredCapabilities: ["SR-2"],
      seller: { displayName: "Service", identity },
      offering: { ...summary, description: "Service", deliverable: { kind: "attested-payload", payloadFormat: "application/json" } },
      buyerRequirement: { requirementVersion: "1", required: [] },
      pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "deliver-attested-payload" }],
      pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } }, terms: {}, validity: { notBefore: 1 } };
    const listing = { ...scope, signature: sign(scope, "dacs-listing:v1:") };
    const verified = await verifyListing(listing);
    assert.ok(verified);
    const markerScope = { listingId, listingVersion: 1, listingContentHash: verified.contentHash, revokedAt: 1 };
    const marker = { ...markerScope, signature: sign(markerScope, "dacs-revocation:v1:") };
    const binding = await findValidListingRevocation([at(2)], verified, 1, async () => marker);
    assert.ok(binding, "control: the carried marker is independently valid");
    const entry = { listingId, version: 1, contentHash: verified.contentHash,
      anchor: { kind: "storage-program", locator: at(1) }, summary, status: "revoked", revocation: binding, ...overrides };
    const crawl = async (value: unknown) => {
      const raw = JSON.stringify({ indexVersion: "1", generatedAt, seller: claim, listings: [value] });
      const agent = await crawlDomain("seller.example", { validateUrl: async () => ({} as never), fetchJson: async url => {
        const body = url.endsWith("agent.json") ? JSON.stringify({ dacs: { dacsVersion: "1", listings: {
          indexUrl: "https://seller.example/listings.json", indexHash: `sha256-${sha256Hex(raw)}`,
        } } }) : raw;
        return { body: JSON.parse(body), raw: body };
      } });
      assert.ok(!("error" in agent));
      return agent;
    };
    let agent = await crawl(entry);
    assert.equal(agent.withdrawalAuthenticated, false);
    assert.deepEqual(agent.incompleteWithdrawalHashes, name === "complete control" ? [] : [verified.contentHash]);
    const originalFetch = globalThis.fetch;
    const originalPins = process.env.DACS_WITHDRAWAL_SOURCE_PINS;
    process.env.DACS_WITHDRAWAL_SOURCE_PINS = JSON.stringify(pinned ? { "https://seller.example": claim } : {});
    let readable = true;
    let markerReads = 0;
    const tampered = name === "tampered marker control";
    globalThis.fetch = async (input, init) => {
      if (init?.body) return Response.json({ result: 200, response: [] });
      const isMarker = String(input).endsWith(at(2));
      if (isMarker) {
        markerReads++;
        if (!readable) return Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
      }
      return Response.json({ success: true, owner: `0x${key}`,
        data: isMarker ? (tampered ? { ...marker, revokedAt: 2 } : marker) : listing });
    };
    try {
      store.saveRegistrations([]);
      store.saveDomains(["seller.example"]);
      const run = () => reindexAll({ log: () => {}, resolveIdentities: async () => { throw new Error("offline"); },
        crawlWellKnown: async () => ({ agents: [agent], errors: [] }) });
      await run();
      const listings = store.loadCatalog().sellers.flatMap(seller => seller.listings);
      assert.deepEqual(agent.revocations, [binding], "incomplete metadata does not erase the binding");
      assert.ok(markerReads > 0, "the marker was actually read");
      if (tampered) {
        assert.equal(store.retainedListingRevocation(verified.contentHash), null, "unverified bytes cannot establish revocation");
        assert.equal(listings.some(activeOffer), false, "unverified withdrawal carriage cannot introduce an active offer");
        assert.equal(store.hasIncompleteWellKnownWithdrawal(claim, verified.contentHash), pinned);
        return;
      }
      assert.equal(listings.some(activeOffer), false, "revoked discovery must not introduce an active offer");
      assert.equal(listings.length, 1, "a verified tombstone remains indexed");
      assert.equal(listings[0].status, "revoked");
      assert.deepEqual(listings[0].revocation, binding);
      assert.deepEqual(store.retainedListingRevocation(verified.contentHash), binding);
      // A later active mirror and an unread marker cannot undo a verified withdrawal.
      readable = false;
      generatedAt++;
      agent = await crawl({ ...entry, summary, status: "active", revocation: undefined });
      await run();
      assert.equal(store.loadCatalog().sellers.flatMap(seller => seller.listings).some(activeOffer), false);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalPins === undefined) delete process.env.DACS_WITHDRAWAL_SOURCE_PINS;
      else process.env.DACS_WITHDRAWAL_SOURCE_PINS = originalPins;
    }
  });
});
