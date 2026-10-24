import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash, sha256Hex } from "../src/catalog/canonical.js";
import { crawlDomain } from "../src/catalog/wellknown.js";

const directory = mkdtempSync(join(tmpdir(), "dacs-crawl-holds-"));
process.env.DACS_DIRECTORY_DATA = directory;
const store = await import("../src/catalog/store.js");
const { reindexAll } = await import("../src/catalog/reindexCore.js");
const { activeOffer } = await import("../src/catalog/discovery.js");
const fixture = JSON.parse(readFileSync(new URL("./fixtures/reviewbot-listing-anchor.json", import.meta.url), "utf8"));
const seller = fixture.data.agentId;
const hash = contentHash(fixture.data);
const domain = "https://seller.example";
const row = { listingId: fixture.data.serviceId, version: 1, contentHash: hash,
  anchor: { kind: "storage-program", locator: fixture.storageAddress }, status: "active",
  summary: { title: "ReviewBot", category: "services.other", tags: [] } };
let generatedAt = 1;
const crawl = (listings: unknown[] | null) => crawlDomain(domain, {
  validateUrl: async () => ({} as never),
  fetchJson: async (url) => {
    if (listings === null) return null;
    const raw = JSON.stringify({ indexVersion: "1", generatedAt, seller, listings });
    const document = url.endsWith("agent.json") ? JSON.stringify({ dacs: { dacsVersion: "1", listings: {
      indexUrl: `${domain}/listings.json`, indexHash: `sha256-${sha256Hex(raw)}`,
    } } }) : raw;
    return { raw: document, body: JSON.parse(document) };
  },
});
test.after(() => rmSync(directory, { recursive: true, force: true }));

test("complete pinned crawls become indeterminate on failure, omission and malformed rows", async () => {
  const original = globalThis.fetch;
  const pins = process.env.DACS_WITHDRAWAL_SOURCE_PINS;
  process.env.DACS_WITHDRAWAL_SOURCE_PINS = JSON.stringify({ [domain]: seller });
  globalThis.fetch = async (_input, init) => init?.body
    ? Response.json({ result: 200, response: [] }) : Response.json(fixture);
  store.saveRegistrations([{ primaryClaim: seller, displayName: "Service", listingAnchors: [fixture.storageAddress], deals: [] }]);
  store.saveDomains([domain]);
  const run = async (rows: unknown[] | null) => {
    generatedAt++;
    const result = await crawl(rows);
    if (!("error" in result)) assert.ok(result.withdrawalHashes?.every(value =>
      typeof value === "string" && /^[0-9a-f]{64}$/.test(value)), "only canonical hashes enter saved withdrawal state");
    await reindexAll({ nodeDeployment: async () => ({ ok: true as const }), log: () => {}, resolveIdentities: async () => { throw new Error("offline"); },
      crawlWellKnown: async () => "error" in result ? { agents: [], errors: [result] } : { agents: [result], errors: [] } });
    return result;
  };
  const active = () => store.loadCatalog().sellers.flatMap(s => s.listings).some(activeOffer);
  try {
    for (const [name, rows, incomplete] of [
      ["transport failure", null, undefined],
      ["omitted known listing", [], undefined],
      ["null row", [null], "*"],
      ["row without hash", [{ ...row, contentHash: undefined }], "*"],
      ["malformed summary with known hash", [{ ...row, summary: {} }], hash],
      ["conflicting active and revoked rows", [row, { ...row, status: "revoked" }], hash],
    ] as const) {
      await run([row]);
      assert.equal(active(), true, `complete positive control before ${name}`);
      assert.equal(store.hasIncompleteWellKnownWithdrawal(seller, hash), false);
      const result = await run(rows === null ? null : [...rows]);
      if (incomplete !== undefined) {
        assert.ok(!("error" in result));
        assert.ok(result.incompleteWithdrawalHashes?.includes(incomplete), name);
        assert.deepEqual(result.activeListingAnchors, [], name);
      }
      assert.equal(store.hasIncompleteWellKnownWithdrawal(seller, hash), true, name);
      assert.equal(active(), false, name);
      // Repeats preserve the hold; a complete check from the same source recovers it.
      await run(rows === null ? null : [...rows]);
      assert.equal(active(), false, `repeat ${name}`);
    }
    await run([row]);
    assert.equal(active(), true, "fresh complete source recovers admission");
  } finally {
    globalThis.fetch = original;
    if (pins === undefined) delete process.env.DACS_WITHDRAWAL_SOURCE_PINS;
    else process.env.DACS_WITHDRAWAL_SOURCE_PINS = pins;
  }
});

test("rejecting one crawled binding preserves another listing at the same marker locator", async () => {
  const { revocationLogicalAddress } = await import("../src/catalog/listingVerification.js");
  const { ingestWellKnownRevocations } = await import("../src/catalog/reindexCore.js");
  const { indexRegistration } = await import("../src/catalog/indexer.js");
  const marker = `stor-${"3".repeat(40)}`;
  const siblingHash = "e".repeat(64);
  const binding = (id: string, listingHash: string) => ({ sellerPrimaryClaim: seller, listingId: id,
    listingVersion: 1, listingContentHash: listingHash, logicalAddress: revocationLogicalAddress(seller, id, 1),
    markerAnchor: { kind: "storage-program" as const, locator: marker }, markerContentHash: "f".repeat(64) });
  const first = binding(row.listingId, hash);
  const sibling = binding("sibling", siblingHash);
  const raw = JSON.stringify({ indexVersion: "1", generatedAt: ++generatedAt, seller, listings: [
    { ...row, status: "revoked", revocation: first },
    { ...row, listingId: "sibling", contentHash: siblingHash,
      anchor: { kind: "storage-program", locator: `stor-${"4".repeat(40)}` }, status: "revoked", revocation: sibling },
  ] });
  const crawled = await crawlDomain(domain, { validateUrl: async () => ({} as never), fetchJson: async (url) => {
    const document = url.endsWith("agent.json") ? JSON.stringify({ dacs: { dacsVersion: "1", listings: {
      indexUrl: `${domain}/listings.json`, indexHash: `sha256-${sha256Hex(raw)}`,
    } } }) : raw;
    return { raw: document, body: JSON.parse(document) };
  } });
  assert.ok(!("error" in crawled));
  assert.equal(crawled.revocations.length, 2);
  const original = globalThis.fetch;
  const pins = process.env.DACS_WITHDRAWAL_SOURCE_PINS;
  process.env.DACS_WITHDRAWAL_SOURCE_PINS = JSON.stringify({ [domain]: seller });
  globalThis.fetch = async input => String(input).endsWith(fixture.storageAddress) ? Response.json(fixture)
    : String(input).endsWith(marker) ? Response.json({ success: true, data: {}, owner: fixture.owner })
      : Response.json({ success: false }, { status: 503 });
  try {
    await ingestWellKnownRevocations(crawled);
    assert.equal(store.hasIncompleteWellKnownWithdrawal(seller, siblingHash), true);
    await indexRegistration({ primaryClaim: seller, displayName: "Service", listingAnchors: [fixture.storageAddress], deals: [] },
      undefined, async () => { throw new Error("offline"); });
    assert.deepEqual(store.boundWellKnownRevocations(seller, hash, row.listingId, 1), [], "first binding was actually rejected");
    assert.deepEqual(store.boundWellKnownRevocations(seller, siblingHash, "sibling", 1), [sibling]);
    assert.equal(store.hasIncompleteWellKnownWithdrawal(seller, siblingHash), true,
      "another listing's claim at the same locator remains unresolved");
  } finally {
    globalThis.fetch = original;
    if (pins === undefined) delete process.env.DACS_WITHDRAWAL_SOURCE_PINS;
    else process.env.DACS_WITHDRAWAL_SOURCE_PINS = pins;
  }
});

test("a carried binding that names the seller with advisory parameters is not the seller's exact binding", () => {
  const exact = {
    sellerPrimaryClaim: seller, listingId: "exact-binding", listingVersion: 1, listingContentHash: hash,
    logicalAddress: `dacs1-revoked:${encodeURIComponent(seller)}:exact-binding:v1`,
    markerAnchor: { kind: "storage-program", locator: `stor-${"5".repeat(40)}` }, markerContentHash: "e".repeat(64),
  };
  const qualified = {
    ...exact, listingId: "qualified-binding", sellerPrimaryClaim: `${seller}?channel=directory`,
    logicalAddress: `dacs1-revoked:${encodeURIComponent(`${seller}?channel=directory`)}:qualified-binding:v1`,
  };
  store.recordWellKnownWithdrawalCheck("https://binding.example", seller, [hash], [], { generatedAt: 1, hash: "f".repeat(64) }, [exact, qualified]);
  assert.deepEqual(store.boundWellKnownRevocations(seller, hash, "exact-binding", 1), [exact]);
  assert.deepEqual(store.boundWellKnownRevocations(seller, hash, "qualified-binding", 1), []);
});
