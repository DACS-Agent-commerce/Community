import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { noRateCatalog, noRateClaim } from "./fixtures/no-rate-catalog.js";

// POST /api/dacs/index-now writes the public catalog, so it is held to the
// same node pin as reindexAll (scan-robustness.test.ts).
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-index-now-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
process.env.DACS_ADMIN_TOKEN = "index-now-admin";
delete process.env.DEMOS_NODE_BUILDS;
delete process.env.DEMOS_CHAIN_IDENTITY;
const store = await import("../src/catalog/store.js");
const { PINNED_DEMOS_CHAIN_IDENTITY, PINNED_DEMOS_NODE_BUILDS } = await import("../src/catalog/nodeDeployment.js");
const { POST } = await import("../app/api/dacs/index-now/route.js");
test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));

const seed = Uint8Array.from(Buffer.alloc(32, 22));
const seller = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const anchor = `stor-${"b".repeat(40)}`;
const listingScope = {
  listingId: "svc", listingVersion: 1, agentId: seller, serviceId: "svc", name: "Service", description: "Description",
  claimRequirements: [], supportedNegotiation: ["negotiate-fixed-price"], supportedPaymentRails: ["pay-dem"],
  supportedDelivery: ["deliver-attested-payload"],
};
const listing = {
  ...listingScope,
  signature: Buffer.from(await ed25519Sign(Buffer.from("dacs-listing:v1:" + contentHash(listingScope)), privateKeyFromSeed(seed))).toString("hex"),
};

/** node2's getNetworkInfo `nodeVersion` for the pinned commit. */
const cleanBuild = { commit: PINNED_DEMOS_NODE_BUILDS[0], dirty: false, builtAt: "2026-10-14T16:45:24Z" };
let node: { nodeVersion?: Record<string, unknown>; chain: string; down?: boolean } = { nodeVersion: cleanBuild, chain: PINNED_DEMOS_CHAIN_IDENTITY };
let calls: string[] = [];
let storageReads = 0;
globalThis.fetch = async (input, init) => {
  const path = new URL(String(input)).pathname;
  if (path.startsWith("/storage-program/")) {
    storageReads++;
    if (path.slice("/storage-program/".length) !== anchor) return new Response(null, { status: 404 });
    return Response.json({ success: true, owner: `0x${seller.slice(-64)}`, programName: "opaque", data: listing });
  }
  if (node.down) return new Response("unavailable", { status: 503 });
  const call = (JSON.parse(String(init?.body)) as { params?: Array<{ message?: string; data?: { blockNumber?: number } }> }).params?.[0];
  calls.push(String(call?.message));
  if (call?.message === "getNetworkInfo") {
    return node.down
      ? new Response("unavailable", { status: 503 })
      : Response.json({ result: 200, response: { nodeVersion: node.nodeVersion } });
  }
  // Deployed nodes answer block zero with an error; block one names the chain.
  if (call?.message === "getBlockByNumber" && call.data?.blockNumber === 0) return Response.json({ result: 400, response: "error" });
  if (call?.message === "getBlockByNumber" && call.data?.blockNumber === 1) {
    return Response.json({
      result: 200,
      response: { id: 2, number: 1, status: "confirmed", hash: "12".repeat(32), content: { previousHash: node.chain, timestamp: 1 } },
    });
  }
  return Response.json({ result: 200, response: [] });
};

const indexNow = () => POST(new NextRequest("https://directory.example/api/dacs/index-now", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer index-now-admin" },
  body: JSON.stringify({ claim: seller }),
}));

test("index-now requires the pinned chain and treats build drift as a warning", async () => {
  store.saveRegistrations([{ primaryClaim: seller, displayName: "Seller", listingAnchors: [anchor] }]);
  store.saveCatalog({ catalogVersion: "1", generatedAt: 7, sellers: [] });
  const dirty = { ...cleanBuild, dirty: true };
  const cases: Array<[string, typeof node, number, RegExp]> = [
    ["another chain", { nodeVersion: cleanBuild, chain: "aa".repeat(32) }, 409, /not the pinned chain$/],
    ["unreadable node", { nodeVersion: cleanBuild, chain: PINNED_DEMOS_CHAIN_IDENTITY, down: true }, 503,
      /could not read the Demos node's chain; catalog not updated/],
  ];
  for (const [name, reply, status, error] of cases) {
    node = reply;
    calls = [];
    storageReads = 0;
    const response = await indexNow();
    assert.equal(response.status, status, name);
    const body = await response.json() as { ok?: boolean; error?: string };
    assert.equal(body.ok, undefined, name);
    assert.match(String(body.error), error, name);
    if (!reply.down) assert.ok(calls.includes("getBlockByNumber"), name);
    assert.equal(storageReads, 0, `${name}: the registration was not indexed`);
    assert.deepEqual(store.loadCatalog(), { catalogVersion: "1", generatedAt: 7, sellers: [] }, name);
  }

  for (const nodeVersion of [dirty, { ...cleanBuild, commit: "f".repeat(40) }, undefined, cleanBuild]) {
    node = { nodeVersion, chain: PINNED_DEMOS_CHAIN_IDENTITY };
    const response = await indexNow();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.listings, 1);
    assert.equal(Boolean(body.nodeBuildWarning), nodeVersion !== cleanBuild);
    assert.equal(store.loadCatalog().sellers[0].listings[0].status, "active");
  }
});

test("index-now preserves another seller's stored ratings while public TP-1 reads hide them", async () => {
  node = { nodeVersion: cleanBuild, chain: PINNED_DEMOS_CHAIN_IDENTITY };
  store.saveRegistrations([{ primaryClaim: seller, displayName: "Seller", listingAnchors: [anchor] }]);
  const catalog = noRateCatalog();
  const sourceRatings = structuredClone(catalog.sellers[0].deals.map((deal) => deal.ratings));
  store.saveCatalog(catalog);
  assert.equal(store.loadCatalog().sellers[0].deals[0].ratings![0].value, null);

  const response = await indexNow();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).listings, 1);
  const stored = store.loadStoredCatalog();
  assert.equal(stored.sellers.length, 2, "the newly indexed seller was saved alongside the prior seller");
  assert.ok(stored.sellers.some((record) => record.primaryClaim === seller));
  const preserved = stored.sellers.find((record) => record.primaryClaim === noRateClaim)!;
  assert.deepEqual(preserved.deals.map((deal) => deal.ratings), sourceRatings,
    "the write must retain the source ratings, including their signed evidence coordinates");
  const published = store.loadCatalog().sellers.find((record) => record.primaryClaim === noRateClaim)!;
  assert.equal(published.reputation.averageSellerRating, null);
  assert.ok(published.deals.every((deal) => deal.ratings!.every((rating) => rating.value === null)));
});
