import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { onPinnedChain } from "./fixtures/pinned-node.js";

// POST /api/dacs/index-now writes the public catalog, so it passes the same
// chain gate as reindexAll and needs a complete pass recorded on that chain.
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-index-now-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
process.env.DACS_ADMIN_TOKEN = "index-now-admin";
delete process.env.DEMOS_NODE_BUILDS;
delete process.env.DEMOS_CHAIN_IDENTITY;
const store = await import("../src/catalog/store.js");
const { reindexAll } = await import("../src/catalog/reindexCore.js");
const { SCAN_STATE_SCHEMA_VERSION } = await import("../src/catalog/scanState.js");
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
  signature: { algorithm: "ed25519", signer: seller, value: Buffer.from(await ed25519Sign(
    Buffer.from("dacs-listing:v1:" + contentHash(listingScope)), privateKeyFromSeed(seed))).toString("base64url") },
};

/** node2's getNetworkInfo `nodeVersion` for the pinned commit. */
const cleanBuild = { commit: PINNED_DEMOS_NODE_BUILDS[0], dirty: false, builtAt: "2026-10-14T16:45:24Z" };
type NodeReply = { nodeVersion?: Record<string, unknown>; chain: string; failure?: "http" | "timeout" | "malformed"; historyDown?: boolean };
let node: NodeReply = { nodeVersion: cleanBuild, chain: PINNED_DEMOS_CHAIN_IDENTITY };
let storageReads = 0;
let onStorageRead = () => {};
globalThis.fetch = async (input, init) => {
  const path = new URL(String(input)).pathname;
  if (path.startsWith("/storage-program/")) {
    storageReads++;
    onStorageRead();
    if (path.slice("/storage-program/".length) !== anchor) return new Response(null, { status: 404 });
    return Response.json({ success: true, owner: `0x${seller.slice(-64)}`, programName: "opaque", data: listing });
  }
  if (node.failure === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  if (node.failure === "http") return new Response("unavailable", { status: 503 });
  const call = (JSON.parse(String(init?.body)) as { params?: Array<{ message?: string; data?: { blockNumber?: number } }> }).params?.[0];
  if (call?.message === "getNetworkInfo") return Response.json({ result: 200, response: { nodeVersion: node.nodeVersion } });
  // Deployed nodes answer block zero with an error; block one names the chain.
  if (call?.message === "getBlockByNumber" && call.data?.blockNumber === 0) return Response.json({ result: 400, response: "error" });
  if (call?.message === "getBlockByNumber" && call.data?.blockNumber === 1) {
    return Response.json({ result: 200, response: node.failure === "malformed" ? { number: 1, status: "pending" }
      : { id: 2, number: 1, status: "confirmed", hash: "12".repeat(32), content: { previousHash: node.chain, timestamp: 1 } } });
  }
  if (call?.message === "getTransactions" && node.historyDown) return Response.json({ result: 503 });
  return Response.json({ result: 200, response: [] });
};

const indexNow = () => POST(new NextRequest("https://directory.example/api/dacs/index-now", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer index-now-admin" },
  body: JSON.stringify({ claim: seller }),
}));
const currentState = () => ({ chainIdentity: PINNED_DEMOS_CHAIN_IDENTITY, schemaVersion: SCAN_STATE_SCHEMA_VERSION,
  lastSeenTxId: 1, listings: {}, deals: {} });
const unchangedCatalog = { catalogVersion: "1" as const, generatedAt: 7, sellers: [] };
/** The registration was not indexed and the catalog is unchanged. */
async function assertRefused(status: number, error: RegExp, name: string): Promise<void> {
  storageReads = 0;
  store.saveCatalog(unchangedCatalog);
  const response = await indexNow();
  assert.equal(response.status, status, name);
  const body = await response.json() as { ok?: boolean; error?: string };
  assert.equal(body.ok, undefined, name);
  assert.match(String(body.error), error, name);
  assert.equal(storageReads, 0, `${name}: the registration was not indexed`);
  assert.deepEqual(store.loadCatalog(), unchangedCatalog, name);
}

test("index-now refuses another chain or an unreadable node, each with its own cause", async () => {
  store.saveRegistrations([{ primaryClaim: seller, displayName: "Seller", listingAnchors: [anchor] }]);
  store.saveScanState(currentState());
  const cases: Array<[string, NodeReply, number, RegExp]> = [
    ["another chain", { nodeVersion: cleanBuild, chain: "aa".repeat(32) }, 409, /^catalog not updated: WRONG_CHAIN: .*not the pinned chain$/],
    ["HTTP failure", { chain: PINNED_DEMOS_CHAIN_IDENTITY, failure: "http" }, 503, /^catalog not updated: NODE_TRANSPORT: /],
    ["timeout", { chain: PINNED_DEMOS_CHAIN_IDENTITY, failure: "timeout" }, 503, /^catalog not updated: NODE_TIMEOUT: /],
    ["malformed block one", { chain: PINNED_DEMOS_CHAIN_IDENTITY, failure: "malformed" }, 503, /^catalog not updated: GENESIS_UNREADABLE: /],
  ];
  for (const [name, reply, status, error] of cases) {
    node = reply;
    await assertRefused(status, error, name);
  }
});

test("index-now treats build drift as a warning on the pinned chain", async () => {
  store.saveScanState(currentState());
  for (const nodeVersion of [{ ...cleanBuild, dirty: true }, { ...cleanBuild, commit: "f".repeat(40) }, undefined, cleanBuild]) {
    node = { nodeVersion, chain: PINNED_DEMOS_CHAIN_IDENTITY };
    const response = await indexNow();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.listings, 1);
    assert.equal(Boolean(body.nodeBuildWarning), nodeVersion !== cleanBuild);
    assert.equal(store.loadCatalog().sellers[0].listings[0].status, "active");
  }
});

test("index-now answers 409 until a complete pass on this chain is recorded, then indexes", async () => {
  node = { nodeVersion: cleanBuild, chain: PINNED_DEMOS_CHAIN_IDENTITY };
  const notCurrent = /^catalog not updated: no complete reindex on this chain yet; run a full reindex first$/;
  const states: Array<[string, Record<string, unknown>]> = [
    ["another recorded chain", { chainIdentity: "aa".repeat(32) }],
    ["legacy state with no identity", { chainIdentity: undefined }],
    ["unfinished reset", { chainIdentity: undefined, schemaVersion: 0, lastSeenTxId: 0 }],
    ["old schema version", { schemaVersion: SCAN_STATE_SCHEMA_VERSION - 1 }],
  ];
  for (const [name, change] of states) {
    store.saveScanState({ ...currentState(), ...change });
    await assertRefused(409, notCurrent, name);
  }

  // A real re-pin whose replay fails leaves the state reset.
  store.saveScanState({ ...currentState(), chainIdentity: "aa".repeat(32) });
  node = { ...node, historyDown: true };
  const pass = { log: () => {}, nodeDeployment: onPinnedChain, resolveIdentities: async () => { throw new Error("offline"); },
    crawlWellKnown: async () => ({ agents: [], errors: [] }) };
  await assert.rejects(reindexAll(pass), /chain scan failed/);
  await assertRefused(409, notCurrent, "reset followed by a failed scan");

  node = { nodeVersion: cleanBuild, chain: PINNED_DEMOS_CHAIN_IDENTITY };
  await reindexAll(pass);
  const response = await indexNow();
  assert.equal(response.status, 200, "one complete reindex makes the state current");
  assert.equal((await response.json()).listings, 1);
});

test("index-now saves nothing when the node changes chain while the registration is indexed", async () => {
  node = { nodeVersion: cleanBuild, chain: PINNED_DEMOS_CHAIN_IDENTITY };
  store.saveScanState(currentState());
  store.saveCatalog(unchangedCatalog);
  onStorageRead = () => { node = { ...node, chain: "aa".repeat(32) }; };
  try {
    const response = await indexNow();
    assert.equal(response.status, 409);
    assert.match(String((await response.json()).error), /^catalog not updated: WRONG_CHAIN: .*not the pinned chain$/);
    assert.deepEqual(store.loadCatalog(), unchangedCatalog);
  } finally {
    onStorageRead = () => {};
  }
});

test("index-now refuses after a replay that failed before its catalog was saved", async () => {
  node = { nodeVersion: cleanBuild, chain: PINNED_DEMOS_CHAIN_IDENTITY };
  const notCurrent = /^catalog not updated: no complete reindex on this chain yet; run a full reindex first$/;
  // A crawled domain makes the failure land after the scan state is saved and before the catalog is.
  store.saveDomains(["seller.example"]);
  const failingPass = { log: () => {}, nodeDeployment: onPinnedChain, resolveIdentities: async () => { throw new Error("offline"); },
    crawlWellKnown: async () => { throw new Error("stopped before the catalog was saved"); } };
  try {
    for (const [name, change] of [["re-pin", { chainIdentity: "aa".repeat(32) }], ["legacy state", { chainIdentity: undefined }]] as const) {
      store.saveScanState({ ...currentState(), ...change });
      await assert.rejects(reindexAll(failingPass), /stopped before the catalog was saved/, name);
      await assertRefused(409, notCurrent, name);
    }
  } finally {
    store.saveDomains([]);
  }
});
