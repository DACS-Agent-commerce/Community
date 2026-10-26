import assert from "node:assert/strict";
import { onPinnedChain } from "./fixtures/pinned-node.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash, sha256Hex } from "../src/catalog/canonical.js";
import { crawlDomain, wellKnownWithdrawalProvenance } from "../src/catalog/wellknown.js";

const directory = mkdtempSync(join(tmpdir(), "dacs-source-provenance-"));
process.env.DACS_DIRECTORY_DATA = directory;
const store = await import("../src/catalog/store.js");
const { reindexAll } = await import("../src/catalog/reindexCore.js");
const { activeOffer } = await import("../src/catalog/discovery.js");
const fixture = JSON.parse(readFileSync(new URL("./fixtures/reviewbot-listing-anchor.json", import.meta.url), "utf8"));
const seller = fixture.data.agentId;
const hash = contentHash(fixture.data);
test.after(() => { rmSync(directory, { recursive: true, force: true }); delete process.env.DACS_WITHDRAWAL_SOURCE_PINS; });

test("standard unsigned indexes introduce independently verified offers without withdrawal authority", async () => {
  const raw = JSON.stringify({ indexVersion: "1", generatedAt: 1, seller, listings: [{
    listingId: fixture.data.serviceId, version: 1, contentHash: hash,
    anchor: { kind: "storage-program", locator: fixture.storageAddress }, status: "active",
    summary: { title: "ReviewBot", category: "services.other", tags: [] },
  }] });
  const agent = await crawlDomain("seller.example", {
    validateUrl: async () => ({} as never),
    fetchJson: async (url) => {
      const body = url.endsWith("agent.json") ? JSON.stringify({ dacs: { dacsVersion: "1", listings: {
        indexUrl: "https://seller.example/listings.json", indexHash: `sha256-${sha256Hex(raw)}`,
      } } }) : raw;
      return { body: JSON.parse(body), raw: body };
    },
  });
  assert.ok(!("error" in agent));
  assert.equal(agent.withdrawalAuthenticated, false);
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => init?.body
    ? Response.json({ result: 200, response: [] }) : Response.json(fixture);
  try {
    store.saveRegistrations([]); store.saveDomains(["seller.example"]);
    const run = () => reindexAll({ nodeDeployment: onPinnedChain, log: () => {}, resolveIdentities: async () => { throw new Error("offline"); },
      crawlWellKnown: async () => ({ agents: [agent], errors: [] }) });
    for (const pins of ["{}", "[]", "null", "invalid json", JSON.stringify({ "https://other.example": seller }),
      JSON.stringify({ "https://seller.example": `did:demos:agent:${"a".repeat(64)}` })]) {
      process.env.DACS_WITHDRAWAL_SOURCE_PINS = pins;
      agent.incompleteWithdrawalHashes = [hash];
      assert.equal(wellKnownWithdrawalProvenance(agent), undefined, `no authority for ${pins}`);
      await run();
      assert.equal(store.loadCatalog().sellers.flatMap(s => s.listings).some(activeOffer), true,
        `standard discovery works without seller/domain pins ${pins}`);
      assert.equal(store.hasIncompleteWellKnownWithdrawal(seller, hash), false);
    }
    process.env.DACS_WITHDRAWAL_SOURCE_PINS = JSON.stringify({ "https://SELLER.example:443/": seller });
    agent.incompleteWithdrawalHashes = [];
    await run();
    assert.equal(store.loadCatalog().sellers.flatMap(s => s.listings).some(activeOffer), true,
      "positive control: a complete check from the pinned source introduces the offer");
    agent.incompleteWithdrawalHashes = [hash];
    await run();
    assert.equal(store.loadCatalog().sellers.flatMap(s => s.listings).some(activeOffer), false);
    assert.equal(store.hasIncompleteWellKnownWithdrawal(seller, hash), true);
  } finally { globalThis.fetch = original; delete process.env.DACS_WITHDRAWAL_SOURCE_PINS; }
});
