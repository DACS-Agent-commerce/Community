// First: the store must open in a fresh directory, never the checkout's data/.
import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import test from "node:test";
import { ed25519Sign, privateKeyFromSeed } from "@kynesyslabs/dacs/crypto";
import { NextRequest } from "next/server";
import { POST as indexNow } from "../app/api/dacs/index-now/route.js";
import { artifactHash } from "../src/catalog/evidenceGraph.js";
import { PINNED_DEMOS_CHAIN_IDENTITY } from "../src/catalog/nodeDeployment.js";
import { reindexAll } from "../src/catalog/reindexCore.js";
import { registrationMessage } from "../src/catalog/registrationSig.js";
import { indexerDiagnostics, loadCatalog, recordListingRejection, saveDomains, saveRegistrations } from "../src/catalog/store.js";
import type { WellKnownAgent } from "../src/catalog/wellknown.js";
import { dids, maps, seeds, vector } from "./fixtures/current-evidence.js";

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

async function withChainFetch(run: () => Promise<unknown>, anchorOwner = owner): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (init?.body) {
      const call = (JSON.parse(String(init.body)) as { params?: Array<{ message?: string; data?: { blockNumber?: number } }> }).params?.[0];
      // The chain pin the index-now route reads: block one names the chain.
      if (call?.message === "getBlockByNumber") {
        return Response.json(call.data?.blockNumber === 1
          ? { result: 200, response: { id: 2, number: 1, status: "confirmed", hash: "12".repeat(32),
            content: { previousHash: PINNED_DEMOS_CHAIN_IDENTITY, timestamp: 1 } } }
          : { result: 400, response: "error" });
      }
      return Response.json({ result: 200, response: [] });
    }
    const data = maps.get(String(input).split("/").pop() ?? "");
    return data ? Response.json({ success: true, owner: anchorOwner, programName: "dacs:test", data }) : new Response(null, { status: 404 });
  };
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const reindexWith = (crawl: ReturnType<typeof crawling>, anchorOwner = owner): Promise<void> => withChainFetch(
  () => reindexAll({ nodeDeployment: async () => ({ ok: true as const }), log: () => {}, resolveIdentities: async () => { throw new Error("offline"); }, crawlWellKnown: crawl }), anchorOwner);

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

test("a failed crawl keeps a crawl-derived rejection of a registered seller; a complete pass removes it", async () => {
  const { locators } = await vector("known-seller-job", 330);
  saveDomains(["seller.example"]);
  saveRegistrations([registration([locators.listing])]);
  recordListingRejection(rejectedAt("4"), dids[1], "LISTING_SIGNATURE_INVALID");
  const kept = () => diagnostics().some((item) => item.locator === rejectedAt("4"));

  await reindexWith(crawling([], true));
  assert.equal(kept(), true, "the registration does not name this anchor, so an incomplete crawl cannot show it is gone");

  await reindexWith(crawling([], false));
  assert.equal(kept(), false, "a complete pass that does not offer the anchor removes it");
});

test("an owner-signed registration keeps its public owner-mismatch notice after a crawl adds anchors", async () => {
  const { locators } = await vector("owner-signed-job", 340);
  const stored = registration([locators.listing]);
  const message = registrationMessage(stored, 1);
  const signature = Buffer.from(await ed25519Sign(Buffer.from(message, "utf8"), privateKeyFromSeed(seeds[1]))).toString("hex");
  saveRegistrations([{ ...stored, ownerSignature: { message, signedAt: 1, signature } }]);
  saveDomains(["seller.example"]);
  await reindexWith(crawling([agentDeclaring(rejectedAt("5"), "f".repeat(64), false)], false), `0x${"f".repeat(64)}`);
  const notice = diagnostics().find((item) => item.locator === locators.listing);
  assert.equal(notice?.code, "OWNER_CLAIM_BINDING");
  assert.equal(notice?.publicNotice, true, "the signature is checked on the registration as the owner signed it");
});

test("an owner-signed registration does not publish an owner-mismatch notice for an anchor only the crawl added", async () => {
  const { locators } = await vector("crawl-only-owner-job", 350);
  const stored = registration([]);
  const message = registrationMessage(stored, 1);
  const signature = Buffer.from(await ed25519Sign(Buffer.from(message, "utf8"), privateKeyFromSeed(seeds[1]))).toString("hex");
  saveRegistrations([{ ...stored, ownerSignature: { message, signedAt: 1, signature } }]);
  saveDomains(["seller.example"]);
  await reindexWith(crawling([agentDeclaring(locators.listing, "f".repeat(64), false)], false), `0x${"f".repeat(64)}`);
  const notice = diagnostics().find((item) => item.locator === locators.listing);
  assert.equal(notice?.code, "OWNER_CLAIM_BINDING");
  assert.equal(notice?.publicNotice, false, "the owner never signed this pointer");
});

test("an operator-pinned unsigned index cannot reject a registered anchor with a declared hash", async () => {
  const { locators } = await vector("pinned-unsigned-job", 360);
  saveDomains(["seller.example"]);
  saveRegistrations([registration([locators.listing])]);
  process.env.DACS_WITHDRAWAL_SOURCE_PINS = JSON.stringify({ [domain]: dids[1] });
  try {
    await reindexWith(crawling([agentDeclaring(locators.listing, "f".repeat(64), false)], false));
  } finally {
    delete process.env.DACS_WITHDRAWAL_SOURCE_PINS;
  }
  assert.equal(diagnostics().some((item) => item.locator === locators.listing), false);
  assert.equal(loadCatalog().sellers.find((seller) => seller.primaryClaim === dids[1])?.listings.length, 1);
});

test("index-now keeps a declared-hash notice and crawl-derived history it cannot rediscover", async () => {
  const { locators } = await vector("immediate-job", 370);
  saveDomains(["seller.example"]);
  saveRegistrations([registration([locators.listing])]);
  await reindexWith(crawling([agentDeclaring(locators.listing, "f".repeat(64), true)], false));
  // Written by a crawl, so the registration as stored does not name this anchor.
  recordListingRejection(rejectedAt("6"), dids[1], "LISTING_SIGNATURE_INVALID");

  await withChainFetch(() => indexNow(new NextRequest("https://directory.example/api/dacs/index-now",
    { method: "POST", body: JSON.stringify({ claim: dids[1] }) })));

  const after = diagnostics().filter((item) => [locators.listing, rejectedAt("6")].includes(item.locator));
  assert.deepEqual(after.map((item) => item.locator).sort(), [locators.listing, rejectedAt("6")].sort());
  assert.equal(after.find((item) => item.locator === locators.listing)?.publicNotice, true);
  assert.equal(loadCatalog().sellers.find((seller) => seller.primaryClaim === dids[1])?.listings.length, 0);
});

test("a corrected declared hash clears the rejection even when an unrelated domain fails to crawl", async () => {
  const { listing, locators } = await vector("corrected-hash-job", 380);
  saveDomains(["seller.example", "dead.example"]);
  saveRegistrations([registration([locators.listing])]);
  const crawlingWithDeadDomain = (declaredHash: string) => async () => ({
    agents: [agentDeclaring(locators.listing, declaredHash, true)],
    errors: [{ domain: "https://dead.example", error: "offline" }],
  });
  const notice = () => diagnostics().find((item) => item.locator === locators.listing);
  const listingCount = () => loadCatalog().sellers.find((seller) => seller.primaryClaim === dids[1])?.listings.length;

  await reindexWith(crawling([agentDeclaring(locators.listing, "f".repeat(64), true)], false));
  assert.equal(notice()?.code, "DECLARED_CONTENT_HASH_MISMATCH");
  assert.equal(listingCount(), 0);

  await reindexWith(crawlingWithDeadDomain(artifactHash(listing, "listing")));
  assert.equal(notice(), undefined, "the seller declared the matching hash in this pass");
  assert.equal(listingCount(), 1);
});
