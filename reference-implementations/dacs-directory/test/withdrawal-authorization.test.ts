import assert from "node:assert/strict";
import { onPinnedChain } from "./fixtures/pinned-node.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash, sha256Hex } from "../src/catalog/canonical.js";
import { crawlDomain, listingIndexEntryIsComplete } from "../src/catalog/wellknown.js";
import { revocationLogicalAddress, verifyListing } from "../src/catalog/listingVerification.js";

const directory = mkdtempSync(join(tmpdir(), "dacs-withdrawal-authorization-"));
process.env.DACS_DIRECTORY_DATA = directory;
const store = await import("../src/catalog/store.js");
const { reindexAll } = await import("../src/catalog/reindexCore.js");
const { activeOffer } = await import("../src/catalog/discovery.js");
const fixture = JSON.parse(readFileSync(new URL("./fixtures/reviewbot-listing-anchor.json", import.meta.url), "utf8"));
const seller = fixture.data.agentId;
const hash = contentHash(fixture.data);
const domain = "https://authorization.example";
const row = { listingId: fixture.data.serviceId, version: 1, contentHash: hash,
  anchor: { kind: "storage-program", locator: fixture.storageAddress }, status: "active",
  summary: { title: "ReviewBot", category: "services.other", tags: [] } };
let generatedAt = 0;
const crawl = async (listings: unknown[]) => {
  const index = JSON.stringify({ indexVersion: "1", generatedAt: ++generatedAt, seller, listings });
  const result = await crawlDomain(domain, { validateUrl: async () => ({} as never), fetchJson: async url => {
    const raw = url.endsWith("agent.json") ? JSON.stringify({ dacs: { dacsVersion: "1", listings: {
      indexUrl: `${domain}/listings.json`, indexHash: `sha256-${sha256Hex(index)}`,
    } } }) : index;
    return { raw, body: JSON.parse(raw) };
  } });
  assert.ok(!("error" in result));
  return result;
};
const visible = () => store.loadCatalog().sellers.flatMap(s => s.listings).filter(activeOffer);
const run = async (listings: unknown[]) => {
  const agent = await crawl(listings);
  await reindexAll({ nodeDeployment: onPinnedChain, log: () => {}, resolveIdentities: async () => { throw new Error("offline"); },
    crawlWellKnown: async () => ({ agents: [agent], errors: [] }) });
  return agent;
};
test.after(() => rmSync(directory, { recursive: true, force: true }));

test("withdrawal authority gates hold valid independently registered offers until a complete check", async () => {
  const original = globalThis.fetch;
  const previousPins = process.env.DACS_WITHDRAWAL_SOURCE_PINS;
  process.env.DACS_WITHDRAWAL_SOURCE_PINS = JSON.stringify({ [domain]: seller });
  globalThis.fetch = async (input, init) => init?.body ? Response.json({ result: 200, response: [] })
    : String(input).endsWith(fixture.storageAddress) ? Response.json(fixture)
      : Response.json({ success: true, owner: fixture.owner, data: {} });
  store.saveRegistrations([{ primaryClaim: seller, displayName: "Service", listingAnchors: [fixture.storageAddress], deals: [] }]);
  store.saveDomains([domain]);
  try {
    assert.equal((await verifyListing(fixture.data))?.contentHash, hash,
      "a real signature/hash control prevents unrelated verification failures masking withdrawal gates");
    // The very first source observation has no usable hash. Its wildcard also
    // covers offers introduced independently of the well-known source.
    const malformed = await run([null]);
    assert.equal(visible().length, 0, "first malformed source holds independently registered offers");
    assert.deepEqual(malformed.incompleteWithdrawalHashes, ["*"]);
    assert.equal(store.hasIncompleteWellKnownWithdrawal(seller, hash), true);
    await run([null]);
    assert.equal(visible().length, 0, "a repeated incomplete observation cannot release the hold");
    await run([row]);
    assert.equal(visible().length, 1, "complete authenticated source recovers the valid offer");

    const binding = { sellerPrimaryClaim: seller, listingId: row.listingId, listingVersion: 1,
      listingContentHash: hash, logicalAddress: revocationLogicalAddress(seller, row.listingId, 1),
      markerAnchor: { kind: "storage-program", locator: `stor-${"4".repeat(40)}` }, markerContentHash: "f".repeat(64) };
    const revoked = { ...row, status: "revoked", revocation: binding };
    assert.equal(listingIndexEntryIsComplete(revoked, seller), true, "well-formed binding control");
    for (const [name, changed] of [
      ["listing hash", { listingContentHash: "e".repeat(64) }],
      ["listing id", { listingId: "another-listing" }],
      ["listing version", { listingVersion: 2 }],
      ["seller", { sellerPrimaryClaim: `did:demos:agent:${"e".repeat(64)}` }],
      ["logical address", { logicalAddress: revocationLogicalAddress(seller, "another-listing", 1) }],
    ] as const) {
      await run([row]);
      assert.equal(visible().length, 1, `valid active control before wrong ${name}`);
      const bad = { ...revoked, revocation: { ...binding, ...changed } };
      const agent = await run([bad]);
      assert.equal(visible().length, 0, `wrong ${name} cannot authorize an active offer`);
      assert.equal(listingIndexEntryIsComplete(bad, seller), false, `binding rejects wrong ${name}`);
      assert.deepEqual(agent.revocations, [], `wrong ${name} cannot be accepted as a carried binding`);
      assert.ok(agent.incompleteWithdrawalHashes?.includes(hash));
    }
    await run([row]);
    assert.equal(visible().length, 1, "authenticated complete control before authentication loss");
    delete process.env.DACS_WITHDRAWAL_SOURCE_PINS;
    await run([row]);
    assert.equal(visible().length, 0, "unsigned recrawl cannot release or retain an active offer");
    assert.equal(store.hasIncompleteWellKnownWithdrawal(seller, hash), true,
      "loss of authentication keeps the prior source incomplete");
    await run([row]);
    assert.equal(visible().length, 0, "repeating unsigned discovery cannot release the hold");
    process.env.DACS_WITHDRAWAL_SOURCE_PINS = JSON.stringify({ [domain]: seller });
    await run([row]);
    assert.equal(visible().length, 1, "a fresh authenticated complete recrawl releases the hold");
  } finally {
    globalThis.fetch = original;
    if (previousPins === undefined) delete process.env.DACS_WITHDRAWAL_SOURCE_PINS;
    else process.env.DACS_WITHDRAWAL_SOURCE_PINS = previousPins;
  }
});
