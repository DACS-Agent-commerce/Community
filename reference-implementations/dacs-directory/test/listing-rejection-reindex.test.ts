// First: the store must open in a fresh directory, never the checkout's data/.
import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import test from "node:test";
import { reindexAll } from "../src/catalog/reindexCore.js";
import { indexerDiagnostics, recordListingRejection, saveDomains, saveRegistrations } from "../src/catalog/store.js";
import type { WellKnownAgent } from "../src/catalog/wellknown.js";
import { dids, maps, vector } from "./fixtures/current-evidence.js";

const owner = `0x${dids[1].slice(-64)}`;
const departedSeller = `did:demos:agent:${"d1".repeat(32)}`;
const crawlOnlySeller = `did:demos:agent:${"c2".repeat(32)}`;
const domain = "https://seller.example";
const rejectedAt = (digit: string) => `stor-${digit.repeat(40)}`;

const registration = (listingAnchors: string[]) => ({ primaryClaim: dids[1], displayName: "seller", listingAnchors, deals: [] });
const agentDeclaring = (anchor: string, declaredHash: string, authenticated: boolean): WellKnownAgent => ({
  domain, seller: dids[1], listingAnchors: [anchor], activeListingAnchors: [anchor], contentHashes: { [anchor]: declaredHash },
  revocations: [], bundleBindings: [], withdrawalAuthenticated: authenticated, withdrawalHashes: [anchor],
  withdrawalIndex: { generatedAt: 1, hash: "a".repeat(64) },
});
const crawling = (agents: WellKnownAgent[], failed: boolean) => async () => ({
  agents, errors: failed ? [{ domain, error: "offline" }] : [],
});

async function reindexWith(crawl: ReturnType<typeof crawling>): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (init?.body) return Response.json({ result: 200, response: [] });
    const data = maps.get(String(input).split("/").pop() ?? "");
    return data ? Response.json({ success: true, owner, programName: "dacs:test", data }) : new Response(null, { status: 404 });
  };
  try {
    await reindexAll({ log: () => {}, resolveIdentities: async () => { throw new Error("offline"); }, crawlWellKnown: crawl });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const diagnostics = () => indexerDiagnostics().listingRejectionDiagnostics.items;

test("a publisher-authenticated declared hash that mismatches a registered anchor becomes a public notice", async () => {
  const { locators } = await vector("declared-hash-job", 300);
  saveDomains(["seller.example"]);
  saveRegistrations([registration([locators.listing])]);
  await reindexWith(crawling([agentDeclaring(locators.listing, "f".repeat(64), true)], false));
  const notice = diagnostics().find((item) => item.locator === locators.listing);
  assert.equal(notice?.code, "DECLARED_CONTENT_HASH_MISMATCH");
  assert.equal(notice?.publicNotice, true);
  assert.equal(notice?.listingId, "svc");
});

test("an unauthenticated declared hash neither rejects a registered anchor nor creates a notice", async () => {
  const { locators } = await vector("declared-hash-job", 300);
  saveDomains(["seller.example"]);
  saveRegistrations([registration([locators.listing])]);
  await reindexWith(crawling([agentDeclaring(locators.listing, "f".repeat(64), false)], false));
  assert.equal(diagnostics().some((item) => item.locator === locators.listing), false);
});

test("a failed crawl keeps the rejection history of a seller only the crawl discovers; a complete pass removes departed sellers", async () => {
  const { locators } = await vector("prune-job", 310);
  saveDomains(["seller.example"]);
  saveRegistrations([registration([locators.listing])]);
  recordListingRejection(rejectedAt("1"), crawlOnlySeller, "LISTING_SIGNATURE_INVALID");
  recordListingRejection(rejectedAt("2"), departedSeller, "LISTING_SIGNATURE_INVALID");
  const remaining = () => diagnostics().map((item) => item.locator).filter((locator) => [rejectedAt("1"), rejectedAt("2")].includes(locator)).sort();

  await reindexWith(crawling([], true));
  assert.deepEqual(remaining(), [rejectedAt("1"), rejectedAt("2")], "an incomplete discovery pass proves no removal");

  await reindexWith(crawling([], false));
  assert.deepEqual(remaining(), [], "a complete pass removes rows of sellers that are no longer registered or discovered");
});
