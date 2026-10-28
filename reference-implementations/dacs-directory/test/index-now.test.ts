import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { nodeOnChain, onPinnedChain } from "./fixtures/pinned-node.js";
import { refuseCatalogWrites } from "./fixtures/refuse-catalog-writes.js";

// POST /api/dacs/index-now writes the public catalog, so it passes the same
// chain gate as reindexAll and needs a complete pass recorded on that chain.
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-index-now-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
process.env.DACS_ADMIN_TOKEN = "index-now-admin";
delete process.env.DEMOS_NODE_BUILDS;
delete process.env.DEMOS_CHAIN_IDENTITY;
const { findValidListingRevocation, verifyStoredListing } = await import("../src/catalog/listingVerification.js");
const store = await import("../src/catalog/store.js");
const { seedScanState, readyChain } = await import("./fixtures/chain-state.js");
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
type NodeReply = { nodeVersion?: Record<string, unknown>; chain: string; failure?: "http" | "timeout" | "malformed"; historyDown?: boolean;
  /** Newest transaction id; the history is then transactions tip..1 with no artifacts. */
  tip?: number };
let node: NodeReply = { nodeVersion: cleanBuild, chain: PINNED_DEMOS_CHAIN_IDENTITY };
let storageReads = 0;
let onStorageRead = () => {};
let storedListing: Record<string, unknown> = listing;
globalThis.fetch = async (input, init) => {
  const path = new URL(String(input)).pathname;
  if (path.startsWith("/storage-program/")) {
    storageReads++;
    onStorageRead();
    if (path.slice("/storage-program/".length) !== anchor) return new Response(null, { status: 404 });
    return Response.json({ success: true, owner: `0x${seller.slice(-64)}`, programName: "opaque", data: storedListing });
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
  if (call?.message === "getTransactions" && node.tip) {
    const { start, limit } = (call as { data: { start: number | "latest"; limit: number } }).data;
    const first = start === "latest" ? node.tip : start;
    return Response.json({ result: 200, response: Array.from({ length: Math.min(limit, first) }, (_, i) => ({ id: first - i })) });
  }
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
  seedScanState(currentState());
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
  seedScanState(currentState());
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
    seedScanState({ ...currentState(), ...change });
    await assertRefused(409, notCurrent, name);
  }

  // A real re-pin whose replay fails leaves the state reset.
  seedScanState({ ...currentState(), chainIdentity: "aa".repeat(32) });
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
  seedScanState(currentState());
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
      seedScanState({ ...currentState(), ...change });
      await assert.rejects(reindexAll(failingPass), /stopped before the catalog was saved/, name);
      await assertRefused(409, notCurrent, name);
    }
  } finally {
    store.saveDomains([]);
  }
});

// Indexing records rejections and revocation progress as it reads. A writer whose
// last chain check fails keeps none of them, and reverts a crashed writer's too.
const offlinePass = { log: () => {}, resolveIdentities: async () => { throw new Error("offline"); },
  crawlWellKnown: async () => ({ agents: [], errors: [] }) };
const notCurrent = /^catalog not updated: no complete reindex on this chain yet; run a full reindex first$/;
const badSignature = { ...listing, signature: { ...listing.signature, value: Buffer.alloc(64, 1).toString("base64url") } };
const rejections = () => store.indexerDiagnostics().listingRejectionDiagnostics.items.map((item) => item.code);
/** Run `write` with the listing read answered by `stored`, after which the node fails its next chain read. */
async function withChainLostOnRead<T>(stored: Record<string, unknown>, lost: Partial<NodeReply>, write: () => Promise<T>): Promise<T> {
  node = { nodeVersion: cleanBuild, chain: PINNED_DEMOS_CHAIN_IDENTITY };
  seedScanState(currentState());
  store.saveCatalog(unchangedCatalog);
  storedListing = stored;
  onStorageRead = () => { node = { ...node, ...lost }; };
  try {
    return await write();
  } finally {
    onStorageRead = () => {};
    storedListing = listing;
    node = { nodeVersion: cleanBuild, chain: PINNED_DEMOS_CHAIN_IDENTITY };
  }
}

test("index-now keeps no rejection it recorded when the node changes chain while indexing", async () => {
  store.clearChainDerivedArtifacts();
  const response = await withChainLostOnRead(badSignature, { chain: "aa".repeat(32) }, indexNow);
  assert.equal(response.status, 409);
  assert.deepEqual(rejections(), []);
  assert.deepEqual(store.loadCatalog(), unchangedCatalog);
});

for (const [name, lost, status] of [["changes chain", { chain: "aa".repeat(32) }, 409], ["fails its last chain read", { failure: "timeout" }, 503]] as const) {
  test(`index-now withholds the recorded chain when the node ${name} while indexing`, async () => {
    const response = await withChainLostOnRead(listing, lost, indexNow);
    assert.equal(response.status, status);
    assert.deepEqual(store.loadCatalog(), unchangedCatalog);
    assert.equal(readyChain(), undefined);
    await assertRefused(409, notCurrent, name);
  });
}

test("a batch pass withholds the recorded chain when the node changes chain while sellers are indexed", async () => {
  await assert.rejects(withChainLostOnRead(listing, { chain: "aa".repeat(32) }, () => reindexAll(offlinePass)),
    /catalog not updated: the served chain changed during the pass: WRONG_CHAIN: /);
  assert.deepEqual(store.loadCatalog(), unchangedCatalog);
  assert.equal(readyChain(), undefined);
  await assertRefused(409, notCurrent, "withheld chain");
});

test("index-now keeps an earlier rejection it cleared when the node changes chain while indexing", async () => {
  store.clearChainDerivedArtifacts();
  store.recordListingRejection(anchor, seller, "SELLER_CLAIM_BINDING");
  const response = await withChainLostOnRead(listing, { chain: "aa".repeat(32) }, indexNow);
  assert.equal(response.status, 409);
  assert.deepEqual(rejections(), ["SELLER_CLAIM_BINDING"]);
});

test("index-now keeps no rejection it recorded when its last chain read times out", async () => {
  store.clearChainDerivedArtifacts();
  const response = await withChainLostOnRead(badSignature, { failure: "timeout" }, indexNow);
  assert.equal(response.status, 503);
  assert.deepEqual(rejections(), []);
});

test("a batch pass keeps no rejection it recorded when the node changes chain while sellers are indexed", async () => {
  store.clearChainDerivedArtifacts();
  await assert.rejects(withChainLostOnRead(badSignature, { chain: "aa".repeat(32) }, () => reindexAll(offlinePass)),
    /catalog not updated: the served chain changed during the pass: WRONG_CHAIN: /);
  assert.deepEqual(rejections(), []);
  assert.deepEqual(store.loadCatalog(), unchangedCatalog);
});

test("index-now keeps no rejection it recorded when its catalog cannot be saved", async () => {
  store.clearChainDerivedArtifacts();
  const indexWithCatalogRefused = async () => {
    const allowCatalogWrites = refuseCatalogWrites(dataDirectory);
    try {
      return await indexNow();
    } finally {
      allowCatalogWrites();
    }
  };
  await assert.rejects(withChainLostOnRead(badSignature, {}, indexWithCatalogRefused), /the catalog write failed/);
  assert.deepEqual(rejections(), []);
  assert.deepEqual(store.loadCatalog(), unchangedCatalog);
});

test("a writer reverts the unconfirmed writes a crashed writer left behind", async () => {
  node = { nodeVersion: cleanBuild, chain: PINNED_DEMOS_CHAIN_IDENTITY };
  store.clearChainDerivedArtifacts();
  seedScanState(currentState());
  // A crash after indexing wrote a rejection, before its chain check.
  store.openChainReadWindow();
  store.recordListingRejection(anchor, seller, "SELLER_CLAIM_BINDING");
  storedListing = badSignature;
  storageReads = 0;
  try {
    // A refused writer only reverts: the node now serves another chain.
    node = { ...node, chain: "aa".repeat(32) };
    assert.equal((await indexNow()).status, 409);
    assert.equal(storageReads, 0);
    assert.deepEqual(rejections(), []);
  } finally {
    storedListing = listing;
    node = { nodeVersion: cleanBuild, chain: PINNED_DEMOS_CHAIN_IDENTITY };
  }
});

test("a complete pass records the chain again after one was withheld", async () => {
  node = { nodeVersion: cleanBuild, chain: PINNED_DEMOS_CHAIN_IDENTITY };
  await reindexAll({ ...offlinePass, nodeDeployment: onPinnedChain });
  assert.equal(readyChain(), PINNED_DEMOS_CHAIN_IDENTITY);
  assert.equal((await indexNow()).status, 200);
});

const marker = `stor-${"2".repeat(40)}`;
const cciBadge = { kind: "web2" as const, platform: "github", handle: "seller", ref: "gh:seller" };
/**
 * Index the seller, then record a withdrawal of its Listing verified on an earlier pass: the catalog
 * record, the retained binding and the scan state. The marker now reads 404. Returns the content hash.
 */
async function withdrawnOnEarlierPass(change: Record<string, unknown>): Promise<string> {
  store.saveRegistrations([{ primaryClaim: seller, displayName: "Seller", listingAnchors: [anchor] }]);
  node = { nodeVersion: cleanBuild, chain: PINNED_DEMOS_CHAIN_IDENTITY };
  store.clearChainDerivedArtifacts();
  seedScanState(currentState());
  store.saveCatalog(unchangedCatalog);
  assert.equal((await indexNow()).status, 200);
  const indexed = store.loadCatalog().sellers[0];
  const { contentHash: hash } = indexed.listings[0];
  const verified = await verifyStoredListing(listing, anchor);
  assert.ok(verified);
  const scope = { listingId: "svc", listingVersion: 1, listingContentHash: hash, revokedAt: 1 };
  const signedMarker = { ...scope, signature: { algorithm: "ed25519", signer: seller,
    value: Buffer.from(await ed25519Sign(Buffer.from("dacs-revocation:v1:" + contentHash(scope)), privateKeyFromSeed(seed))).toString("base64url") } };
  const revocation = await findValidListingRevocation([marker], verified, 1, async () => signedMarker);
  assert.ok(revocation, "the retained withdrawal is cryptographically verified");
  store.saveCatalog({ catalogVersion: "1", generatedAt: 8, sellers: [{ ...indexed, registeredAt: 1, cci: [cciBadge],
    listings: [{ ...indexed.listings[0], status: "revoked", revocation }] }] });
  store.retainListingRevocation(revocation, signedMarker);
  seedScanState({ ...currentState(), verifiedRevocations: { [hash]: [marker] }, ...change });
  return hash;
}
const listingStatus = () => store.loadCatalog().sellers[0].listings[0].status;

test("after a re-pin, the rebuild takes no revocation from the replaced chain's catalog or cache", async () => {
  const hash = await withdrawnOnEarlierPass({ chainIdentity: "aa".repeat(32) });
  await reindexAll({ ...offlinePass, nodeDeployment: onPinnedChain });
  assert.equal(listingStatus(), "active");
  assert.equal(store.retainedListingRevocation(hash), null);
  assert.equal(readyChain(), PINNED_DEMOS_CHAIN_IDENTITY);
});

// RB-3: a withdrawal verified on an earlier pass of this chain stays in force whatever its marker reads
// now. Only a different recorded chain proves that evidence foreign; nothing else may drop it.
test("a state with no recorded chain replays and keeps a verified withdrawal whose marker now reads 404", async () => {
  const hash = await withdrawnOnEarlierPass({ chainIdentity: undefined });
  await reindexAll({ ...offlinePass, nodeDeployment: onPinnedChain });
  assert.equal(listingStatus(), "revoked");
  assert.notEqual(store.retainedListingRevocation(hash), null);
  assert.equal(readyChain(), PINNED_DEMOS_CHAIN_IDENTITY);
});

test("a same-chain large tip regression keeps a verified withdrawal through the earlier catalog", async () => {
  await withdrawnOnEarlierPass({ lastSeenTxId: 5000, lastChainTip: 5 });
  node = { ...node, tip: 5 };
  await reindexAll({ ...offlinePass, nodeDeployment: onPinnedChain });
  assert.equal(listingStatus(), "revoked");
});

const timedOutWriters: Array<[string, () => Promise<void>]> = [
  ["index-now", async () => assert.equal((await indexNow()).status, 503)],
  ["a batch pass", () => assert.rejects(reindexAll(offlinePass), /NODE_TIMEOUT/)],
];
for (const [name, timedOut] of timedOutWriters) {
  test(`after ${name} times out on its last chain read, the next pass keeps a verified withdrawal`, async () => {
    const hash = await withdrawnOnEarlierPass({});
    onStorageRead = () => { node = { ...node, failure: "timeout" }; };
    try {
      await timedOut();
    } finally {
      onStorageRead = () => {};
      node = { nodeVersion: cleanBuild, chain: PINNED_DEMOS_CHAIN_IDENTITY };
    }
    assert.equal(readyChain(), undefined, "the chain is withheld");
    await reindexAll({ ...offlinePass, nodeDeployment: onPinnedChain });
    assert.equal(listingStatus(), "revoked");
    assert.notEqual(store.retainedListingRevocation(hash), null);
  });
}

test("a state with no recorded chain whose replay exceeds DACS_SCAN_MAX_TXS fails and deletes nothing", async () => {
  const hash = await withdrawnOnEarlierPass({ chainIdentity: undefined });
  const catalog = store.loadCatalog();
  node = { ...node, tip: 500 };
  process.env.DACS_SCAN_MAX_TXS = "2";
  try {
    await assert.rejects(reindexAll({ ...offlinePass, nodeDeployment: onPinnedChain }), /DACS_SCAN_MAX_TXS=2/);
  } finally {
    delete process.env.DACS_SCAN_MAX_TXS;
    node = { nodeVersion: cleanBuild, chain: PINNED_DEMOS_CHAIN_IDENTITY };
  }
  assert.deepEqual(store.loadCatalog(), catalog);
  assert.notEqual(store.retainedListingRevocation(hash), null);
  assert.deepEqual(store.loadScanState().verifiedRevocations?.[hash], [marker]);
});

test("a state with no recorded chain keeps each seller's registeredAt and badges while identities are offline", async () => {
  await withdrawnOnEarlierPass({ chainIdentity: undefined });
  await reindexAll({ ...offlinePass, nodeDeployment: onPinnedChain });
  const [rebuilt] = store.loadCatalog().sellers;
  assert.equal(rebuilt.registeredAt, 1);
  assert.deepEqual(rebuilt.cci, [cciBadge]);
});

// Last successful chain provenance must survive every refused writer until a new complete pass.
for (const [writer, write] of [
  ["index-now", async () => { assert.ok([409, 503].includes((await indexNow()).status)); }],
  ["batch", async () => { await assert.rejects(reindexAll(offlinePass), /catalog not updated:/); }],
] as const) for (const [loss, changed] of [
  ["chain change", { chain: "aa".repeat(32) }], ["timeout", { failure: "timeout" }],
] as const) {
  test(`a re-pin after ${writer} ${loss} clears foreign evidence even when rebuilding fails`, async () => {
    const hash = await withdrawnOnEarlierPass({});
    onStorageRead = () => { node = { ...node, ...changed }; };
    try { await write(); } finally { onStorageRead = () => {}; }
    const restarted = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { loadCatalogChain } from './src/catalog/store.ts';
      assert.equal(loadCatalogChain()?.evidenceChain, ${JSON.stringify(PINNED_DEMOS_CHAIN_IDENTITY)});
    `], { encoding: "utf8", timeout: 30_000, env: process.env });
    assert.equal(restarted.status, 0, restarted.stderr);
    node = { nodeVersion: cleanBuild, chain: "aa".repeat(32), historyDown: true };
    const repinned = { ...offlinePass, nodeDeployment: nodeOnChain(node.chain) };
    await assert.rejects(reindexAll(repinned), /chain scan failed/);
    assert.deepEqual(store.loadCatalog().sellers, [], "foreign catalog is hidden before the failed rebuild");
    assert.equal(store.retainedListingRevocation(hash), null, "foreign withdrawals are cleared");
    node = { ...node, historyDown: false };
    await reindexAll(repinned);
    assert.equal(listingStatus(), "active", "a restarted rebuild cannot reuse a foreign withdrawal");
    assert.equal(readyChain(), node.chain);
    node = { nodeVersion: cleanBuild, chain: PINNED_DEMOS_CHAIN_IDENTITY };
  });
}

for (const interruption of ["same-chain reset", "replacement reset", "legacy adoption"] as const) {
  test(`a failed ${interruption} retains provenance across restart and another re-pin`, async () => {
    const hash = await withdrawnOnEarlierPass(interruption === "legacy adoption" ? { chainIdentity: undefined } : {});
    store.saveDomains(["interrupted.example"]);
    const intermediate = interruption === "replacement reset" ? "bb".repeat(32) : PINNED_DEMOS_CHAIN_IDENTITY;
    if (interruption === "same-chain reset") {
      store.saveScanState({ ...store.loadScanState(), lastSeenTxId: 5000, lastChainTip: 5 });
      node = { ...node, tip: 5 };
    }
    try {
      await assert.rejects(reindexAll({ ...offlinePass, nodeDeployment: nodeOnChain(intermediate),
        crawlWellKnown: async () => {
          store.recordArtifactFailure("stor-" + "7".repeat(40), "listing", "STORAGE_UNREADABLE", "intermediate chain", 1);
          store.recordListingRejection("stor-" + "8".repeat(40), seller, "OWNER_CLAIM_BINDING", { listingId: "svc", listingVersion: 1 }, true);
          store.admitRevocationCandidates(hash, [{ locator: "stor-" + "9".repeat(40) }]);
          throw new Error("interrupted replay");
        } }), /interrupted replay/);
      const restarted = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import { reindexAll } from './src/catalog/reindexCore.ts';
        import * as store from './src/catalog/store.ts';
        import { nodeOnChain } from './test/fixtures/pinned-node.ts';
        globalThis.fetch = async () => Response.json({ result: 503 });
        await assert.rejects(reindexAll({ log: () => {}, nodeDeployment: nodeOnChain('cc'.repeat(32)) }), /chain scan failed/);
        assert.deepEqual(store.loadCatalog().sellers, [], 'foreign catalog, badges and withdrawals must be cleared');
        assert.equal(store.retainedListingRevocation(${JSON.stringify(hash)}), null);
        assert.deepEqual(Object.keys(store.loadScanState().listings), []);
        assert.deepEqual(store.indexerDiagnostics().artifacts, {});
      `], { encoding: "utf8", timeout: 30_000, env: process.env });
      assert.equal(restarted.status, 0, restarted.stderr);
    } finally { store.saveDomains([]); node = { nodeVersion: cleanBuild, chain: PINNED_DEMOS_CHAIN_IDENTITY }; }
  });
}

for (const writer of ["batch", "index-now"] as const) {
  test(`${writer} publication failure retains provenance and requires replay`, async () => {
    await withdrawnOnEarlierPass({});
    const before = store.loadCatalog();
    const db = new Database(join(dataDirectory, "directory.sqlite"));
    db.exec(`CREATE TRIGGER refuse_ready BEFORE UPDATE ON kv_state
      WHEN new.key='catalog-chain' AND json_extract(new.value_json,'$.readySchema') IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'publication refused'); END`);
    try {
      await assert.rejects(writer === "batch" ? reindexAll(offlinePass) : indexNow(), /publication refused/);
      assert.deepEqual(store.loadCatalog(), before);
      assert.equal(readyChain(), undefined);
      assert.equal(store.loadCatalogChain()?.evidenceChain, PINNED_DEMOS_CHAIN_IDENTITY);
    } finally { db.exec("DROP TRIGGER refuse_ready"); db.close(); }
    await assertRefused(409, notCurrent, "failed publication cannot complete replay");
    await reindexAll(offlinePass);
    assert.equal((await indexNow()).status, 200);
  });

  test(`${writer} process death during indexing preserves withdrawals and requires replay`, async (context) => {
    const hash = await withdrawnOnEarlierPass({});
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { NextRequest } from 'next/server';
      import { POST } from './app/api/dacs/index-now/route.ts';
      import { reindexAll } from './src/catalog/reindexCore.ts';
      import { pinnedNodeAnswer } from './test/fixtures/pinned-node.ts';
      globalThis.fetch = async (input, init) => {
        if (String(input).includes('/storage-program/')) process.kill(process.pid, 'SIGKILL');
        return pinnedNodeAnswer(init?.body) ?? Response.json({ result: 200, response: [] });
      };
      ${writer === "batch" ? "await reindexAll({ log: () => {}, resolveIdentities: async () => ({}), crawlWellKnown: async () => ({ agents: [], errors: [] }) });"
        : `await POST(new NextRequest('https://directory.example/api/dacs/index-now', { method: 'POST', headers: { authorization: 'Bearer index-now-admin' }, body: JSON.stringify({ claim: '${seller}' }) }));`}
    `], { encoding: "utf8", timeout: 30_000, env: process.env });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    context.mock.timers.enable({ apis: ["Date"], now: Date.now() + 121_000 });
    assert.equal(readyChain(), undefined);
    assert.equal(store.loadCatalogChain()?.evidenceChain, PINNED_DEMOS_CHAIN_IDENTITY);
    assert.notEqual(store.retainedListingRevocation(hash), null);
    assert.equal((await indexNow()).status, 409);
    await reindexAll(offlinePass);
    assert.equal(listingStatus(), "revoked");
    assert.equal((await indexNow()).status, 200);
  });
}
