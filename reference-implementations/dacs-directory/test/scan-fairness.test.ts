import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import type { BundleBinding, Registration, ScanState } from "../src/catalog/types.js";

// Each listing, deal and retry stays isolated from other parties' writes:
// real SDK hashes and signatures over a stubbed node, through reindexAll.
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-fairness-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
process.env.DACS_SCAN_FINALITY_DEPTH = "0";
const store = await import("../src/catalog/store.js");
const { verifyListing } = await import("../src/catalog/listingVerification.js");
const { logicalBundleAddress, verifyBundleBinding } = await import("../src/catalog/bundleBinding.js");
const { artifactHash } = await import("../src/catalog/evidenceGraph.js");
const { indexRegistration } = await import("../src/catalog/indexer.js");
const { deriveAnchorAddress, resolveOwnedAnchorByName } = await import("../src/catalog/chain.js");
const { reindexAll } = await import("../src/catalog/reindexCore.js");
const { scanChain } = await import("../src/catalog/scan.js");
const { dedupeVerifiedDeals } = await import("../src/catalog/bundlePolicy.js");
const artifactRoute = await import("../app/api/dacs/artifact/route.js");
const dealOwnersRoute = await import("../app/api/dacs/deal-owners/route.js");
const { registrationMessage } = await import("../src/catalog/registrationSig.js");

type Obj = Record<string, unknown>;
const seeds = [21, 22, 23, 24].map((byte) => Uint8Array.from(Buffer.alloc(32, byte)));
const dids = seeds.map((seed) => `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`);
const [buyer, seller, otherBuyer, otherSeller] = dids;
const ownerOf = (did: string) => `0x${did.slice(-64)}`;
const outsider = `did:demos:agent:${"d".repeat(64)}`;
const locator = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;
const range = (from: number, count: number) => Array.from({ length: count }, (_, index) => locator(from + index));
const offline = async (): Promise<never> => { throw new Error("identity unavailable"); };
const signature = async (hash: string, prefix: string, signer: number, encoding: "hex" | "base64url" = "hex") =>
  Buffer.from(await ed25519Sign(Buffer.from(prefix + hash), privateKeyFromSeed(seeds[signer]))).toString(encoding);

const listingScope = {
  listingId: "svc", listingVersion: 1, agentId: seller, serviceId: "svc", name: "Service", description: "Description",
  claimRequirements: [], supportedNegotiation: ["negotiate-fixed-price"], supportedPaymentRails: ["pay-dem"],
  supportedDelivery: ["deliver-attested-payload"],
};
const listing = { ...listingScope, signature: { algorithm: "ed25519", signer: seller, value: await signature(contentHash(listingScope), "dacs-listing:v1:", 1) } };
const verifiedListing = await verifyListing(listing);
assert.ok(verifiedListing);
const listingHash = verifiedListing.contentHash;
const markerScope = { listingId: "svc", listingVersion: 1, listingContentHash: listingHash, revokedAt: 1 };
const marker = { ...markerScope, signature: { algorithm: "ed25519", signer: seller, value: await signature(contentHash(markerScope), "dacs-revocation:v1:", 1) } };
/** Marker-shaped, but its signature does not verify. */
const unsigned = (n: number) => ({ ...markerScope, revokedAt: 1_000 + n, signature: { algorithm: "ed25519", signer: seller, value: "00".repeat(64) } });
async function agreementFor(jobId: string, buyerIndex: number, sellerIndex: number) {
  const scope = { agreementVersion: "1", jobId, listingRef: { listingId: "svc", version: 1, contentHash: listingHash },
    parties: [{ role: "buyer", primaryClaim: dids[buyerIndex] }, { role: "seller", primaryClaim: dids[sellerIndex] }],
    terms: { price: { amount: "1.25", currency: "DEM" }, rail: { railId: "pay-dem" } } };
  const sign = async (index: number) => ({ party: dids[index], algorithm: "ed25519",
    value: await signature(artifactHash(scope, "agreement"), "dacs-agreement:v1:", index) });
  return { ...scope, signatures: [await sign(buyerIndex), await sign(sellerIndex)] };
}

// Stubbed node. `unavailable` locators answer 503; `scanOnly` locators answer only their first read.
interface StoredProgram { data: string; name?: string; owner?: string }
let storage: Record<string, StoredProgram> = {};
let transactions: Obj[] = [];
let reads = new Map<string, number>();
const unavailable = new Set<string>();
const scanOnly = new Set<string>();
let nodeDown = false;
globalThis.fetch = async (input, init) => {
  const path = new URL(String(input)).pathname;
  if (path.startsWith("/storage-program/")) {
    const at = path.slice("/storage-program/".length);
    const count = (reads.get(at) ?? 0) + 1;
    reads.set(at, count);
    const entry = storage[at];
    if (!entry) return new Response(null, { status: 404 });
    if (unavailable.has(at) || (scanOnly.has(at) && count > 1)) return new Response(null, { status: 503 });
    return new Response(`{"success":true,"owner":${JSON.stringify(entry.owner ?? ownerOf(seller))},` +
      `"programName":${JSON.stringify(entry.name ?? "opaque")},"data":${entry.data}}`, { headers: { "content-type": "application/json" } });
  }
  const call = JSON.parse(String(init?.body)).params?.[0];
  if (nodeDown) return Response.json({ result: 503 });
  return Response.json({ result: 200, response: call?.message === "getTransactions" && call.data?.start === "latest" ? transactions : [] });
};
const memo = (id: number, at?: string): Obj => ({ id, status: "confirmed", type: "transfer", hash: id.toString(16).padStart(64, "0"),
  blockNumber: id, to: "0x1", content: JSON.stringify(at ? { memo: at } : {}) });
/** `written` is in chain order (oldest first) from tx id `firstId`; the node returns newest first. */
function chain(programs: Record<string, StoredProgram>, written: string[], firstId = 1) {
  storage = programs;
  reads = new Map();
  unavailable.clear();
  scanOnly.clear();
  transactions = written.map((at, index) => memo(firstId + index, at)).reverse();
}
const readsOf = (locators: string[]) => locators.reduce((total, at) => total + (reads.get(at) ?? 0), 0);

function sql(query: string, ...params: unknown[]) {
  const db = new Database(join(dataDirectory, "directory.sqlite"));
  try {
    const statement = db.prepare(query);
    return (statement.reader ? statement.all(...params) : (statement.run(...params), [])) as Record<string, unknown>[];
  } finally { db.close(); }
}
const emptyState = (): ScanState => ({
  schemaVersion: 9, lastSeenTxId: 0, listings: {}, deals: {}, programs: {}, revocations: {},
  verifiedRevocations: {}, bundleBindings: {}, bundleBindingOverflow: [], anchorBackfillComplete: true,
});
const candidateTable = () => sql("SELECT name FROM sqlite_master WHERE name='revocation_candidates'").length > 0;
function resetIndex(registrations: Registration[], generatedAt: number) {
  store.saveRegistrations(registrations);
  store.saveCatalog({ catalogVersion: "1", generatedAt, sellers: [] });
  store.saveScanState(emptyState());
  sql("DELETE FROM artifacts");
  sql("DELETE FROM dead_letters");
  if (candidateTable()) sql("DELETE FROM revocation_candidates");
}
/** Candidates still queued for a listing, in the order they will be examined. */
const pending = (hash: string) => sql("SELECT locator FROM revocation_candidates WHERE listing_hash=? AND state='pending' ORDER BY seq", hash)
  .map((row) => String(row.locator));
/** SQLite statements executed, and rows they returned, in this process while enabled. */
const sqlWork = { enabled: false, calls: 0, rows: 0 };
{
  const probe = new Database(":memory:");
  const statement = Object.getPrototypeOf(probe.prepare("SELECT 1")) as Record<string, (...args: unknown[]) => unknown>;
  probe.close();
  for (const method of ["get", "all", "run", "iterate"]) {
    const original = statement[method];
    statement[method] = function (this: unknown, ...args: unknown[]) {
      const result = original.apply(this, args);
      if (sqlWork.enabled) {
        sqlWork.calls++;
        sqlWork.rows += Array.isArray(result) ? result.length : result === undefined ? 0 : 1;
      }
      return result;
    };
  }
}
const later: Registration = { primaryClaim: outsider, displayName: "Later", listingAnchors: [] };
const sellerRegistration: Registration = { primaryClaim: seller, displayName: "Seller", listingAnchors: [locator(1)] };
const reindex = () => reindexAll({ log: () => {}, resolveIdentities: offline });
const listingStatus = () => store.loadCatalog().sellers.find((s) => s.primaryClaim === seller)?.listings[0]?.status;
const lastRun = () => sql("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1")[0];

test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));

test("a revocation anchored by the listing owner is applied even when many other candidates exist", async () => {
  resetIndex([sellerRegistration, later], 5);
  const older = range(100, 20), newer = range(150, 20);
  chain({
    [locator(1)]: { data: JSON.stringify(listing) },
    [locator(2)]: { data: JSON.stringify(marker) },
    ...Object.fromEntries([...older, ...newer].map((at, n) => [at, { data: JSON.stringify(unsigned(n)), owner: ownerOf(outsider) }])),
  }, [locator(1), ...older, locator(2), ...newer]);
  await reindex();
  assert.equal(listingStatus(), "revoked", "verified in the first pass");
  const candidates = [locator(2), ...older, ...newer];
  // The scanner reads each new locator once; the rest is verification work.
  assert.ok(readsOf(candidates) - candidates.length <= 16, `pass 1 verified ${readsOf(candidates) - candidates.length}`);
  transactions = [];
  reads = new Map();
  await reindex();
  assert.equal(listingStatus(), "revoked");
  assert.ok(readsOf(candidates) <= 16);
});

test("every revocation candidate is eventually verified with bounded work per pass", async () => {
  resetIndex([sellerRegistration, later], 6);
  // The valid marker is anchored by a third party, so it gets no ordering priority.
  // Ahead of it: 16 candidates unreadable after discovery, then 20 that fail verification.
  const older = range(200, 36), newer = range(300, 20);
  const unreadable = older.slice(0, 16);
  chain({
    [locator(1)]: { data: JSON.stringify(listing) },
    [locator(3)]: { data: JSON.stringify(marker), owner: ownerOf(otherBuyer) },
    ...Object.fromEntries([...older, ...newer].map((at, n) => [at, { data: JSON.stringify(unsigned(n)), owner: ownerOf(outsider) }])),
  }, [locator(1), ...older, locator(3), ...newer]);
  for (const at of unreadable) scanOnly.add(at);
  const candidates = [...older, locator(3), ...newer];
  await reindex();
  assert.ok(readsOf(candidates) - candidates.length <= 16, `pass 1 verified ${readsOf(candidates) - candidates.length}`);
  let passes = 1;
  transactions = [];
  while (listingStatus() !== "revoked" && passes < 6) {
    reads = new Map();
    await reindex();
    passes++;
    assert.ok(readsOf(candidates) <= 16, `pass ${passes} verified ${readsOf(candidates)}`);
  }
  assert.equal(listingStatus(), "revoked");
  assert.ok(passes <= Math.ceil(candidates.length / 16), `revoked after ${passes} passes`);
  // Unreadable candidates are kept for a later pass rather than dropped.
  const queued = pending(listingHash);
  for (const at of unreadable) assert.ok(queued.includes(at), `${at} stays queued`);
  // Rejected candidates are not verified again.
  reads = new Map();
  await reindex();
  assert.equal(listingStatus(), "revoked");
  assert.equal(readsOf(older.slice(16)), 0);
  assert.ok(readsOf(candidates) <= 16);
});

test("per-pass revocation work does not grow with the number of queued candidates", async () => {
  const work: Array<{ calls: number; rows: number; verified: number }> = [];
  for (const count of [40, 400]) {
    resetIndex([sellerRegistration, later], 17);
    const queued = range(20_000, count);
    chain({
      [locator(1)]: { data: JSON.stringify(listing) },
      ...Object.fromEntries(queued.map((at, n) => [at, { data: JSON.stringify(unsigned(n)), owner: ownerOf(outsider) }])),
    }, [locator(1), ...queued]);
    await reindex();
    transactions = [];
    reads = new Map();
    sqlWork.calls = sqlWork.rows = 0;
    sqlWork.enabled = true;
    try { await reindex(); } finally { sqlWork.enabled = false; }
    work.push({ calls: sqlWork.calls, rows: sqlWork.rows, verified: readsOf(queued) });
  }
  assert.deepEqual(work[1], work[0], "the same statements and rows with ten times the queue");
  assert.equal(work[0].verified, 16);
  // Nothing unexamined left the queue: two passes examined 32 of the 400.
  assert.equal(pending(listingHash).length, 400 - 32);
});

test("a rejected candidate is verified again only when its content changes", async () => {
  resetIndex([sellerRegistration, later], 18);
  const candidates = range(600, 3);
  chain({
    [locator(1)]: { data: JSON.stringify(listing) },
    ...Object.fromEntries(candidates.map((at, n) => [at, { data: JSON.stringify(unsigned(n)), owner: ownerOf(outsider) }])),
  }, [locator(1), ...candidates]);
  await reindex();
  assert.equal(listingStatus(), "active");
  // Mentioned again with the same content: the scanner reads each once and none is verified again.
  transactions = [memo(50, candidates.join(" "))];
  reads = new Map();
  await reindex();
  assert.equal(readsOf(candidates), candidates.length);
  // New content at one of them is examined.
  storage[candidates[1]] = { data: JSON.stringify(marker), owner: ownerOf(outsider) };
  transactions = [memo(60, candidates[1]), ...transactions];
  await reindex();
  assert.equal(listingStatus(), "revoked");
});

test("a verified marker missing from the candidate queue is still checked first", async () => {
  resetIndex([sellerRegistration, later], 15);
  const others = range(400, 20);
  chain({
    [locator(1)]: { data: JSON.stringify(listing) },
    [locator(4)]: { data: JSON.stringify(marker), owner: ownerOf(otherBuyer) },
    ...Object.fromEntries(others.map((at, n) => [at, { data: JSON.stringify(unsigned(n)), owner: ownerOf(outsider) }])),
  }, [locator(1)]);
  // A snapshot that kept the verified locator but not its queue entry.
  store.saveScanState({ ...emptyState(), revocations: { [listingHash]: others }, verifiedRevocations: { [listingHash]: [locator(4)] } });
  await reindex();
  assert.equal(listingStatus(), "revoked");
  assert.ok(readsOf(others) === 0, "the verified marker is checked before any other candidate");
});

for (const route of ["unsigned bundle-named program", "bundle and agreement signed by its own parties"]) {
  test(`deals are keyed by their owner: another owner's ${route} with the same jobId leaves the deal in place`, async () => {
    const jobId = "shared-job";
    const signedRoute = !route.startsWith("unsigned");
    // The signed route uses current-format bundles; the unsigned route uses name-only programs.
    const currentBundle = JSON.stringify({ bundleVersion: "1", jobId, parties: [], anchoredByRole: "buyer" });
    resetIndex([later], 7);
    chain({
      [locator(40)]: { name: `dacs5:bundle:${jobId}`, data: signedRoute ? currentBundle : '{"any":1}', owner: ownerOf(buyer) },
      [locator(41)]: { name: `dacs3:agreement:${jobId}`, data: JSON.stringify(await agreementFor(jobId, 0, 1)), owner: ownerOf(buyer) },
    }, [locator(40), locator(41)]);
    transactions.unshift(memo(10));
    await reindex();
    const dealsFor = (did: string) => store.loadCatalog().sellers.find((s) => s.primaryClaim === did)?.deals ?? [];
    const entryOf = (did: string) => Object.values(store.loadScanState().deals).filter((deal) => deal.owners.buyer === did && deal.jobId === jobId);
    assert.deepEqual(dealsFor(seller).map((deal) => deal.buyerBundleRef), [locator(40)]);

    // The established writes are outside the next pass's replay overlap.
    const writer = signedRoute ? otherBuyer : outsider;
    storage[locator(42)] = signedRoute
      ? { data: currentBundle, owner: ownerOf(writer) }
      : { name: `dacs5:bundle:${jobId}`, data: '{"any":1}', owner: ownerOf(writer) };
    const second = [locator(42)];
    if (signedRoute) {
      storage[locator(43)] = { name: `dacs3:agreement:${jobId}`, data: JSON.stringify(await agreementFor(jobId, 2, 3)), owner: ownerOf(otherBuyer) };
      second.push(locator(43));
    }
    transactions = [...second.map((at, index) => memo(20 + index, at)).reverse(), ...transactions];
    for (let pass = 2; pass <= 3; pass++) {
      reads = new Map();
      await reindex();
      assert.ok(Number(lastRun().from_tx) > 2, "the established writes (tx 1 and 2) are outside the replay overlap");
      assert.equal(entryOf(buyer).length, 1, `pass ${pass}`);
      assert.equal(entryOf(buyer)[0].owners.seller, seller);
      assert.deepEqual(dealsFor(seller).map((deal) => deal.buyerBundleRef), [locator(40)], `pass ${pass}`);
      assert.equal(entryOf(writer).length, 1, "the other owner's program is its own entry");
      if (!signedRoute) assert.equal(entryOf(writer)[0].owners.seller, "");
      else assert.deepEqual(dealsFor(otherSeller).map((deal) => deal.buyerBundleRef), [locator(42)]);
    }
    // Within one scan window as well, each owner's program is its own entry.
    transactions = [...second, locator(41), locator(40)].map((at, index) => memo(40 - index, at));
    const window = await scanChain(null, { maxTxs: 100, sinceTxId: 0 });
    const scanned = [...window.deals.values()].filter((deal) => deal.jobId === jobId);
    assert.deepEqual(scanned.map((deal) => deal.owners.buyer).sort(), [buyer, writer].sort());
    assert.equal(scanned.find((deal) => deal.owners.buyer === buyer)?.owners.seller, seller);
  });
}

test("two buyers' attributed deals with the same jobId both reach the seller's record", async () => {
  const jobId = "two-buyers";
  resetIndex([later], 19);
  chain({
    [locator(70)]: { name: `dacs5:bundle:${jobId}`, data: '{"any":1}', owner: ownerOf(buyer) },
    [locator(71)]: { name: `dacs3:agreement:${jobId}`, data: JSON.stringify(await agreementFor(jobId, 0, 1)), owner: ownerOf(buyer) },
    [locator(72)]: { name: `dacs5:bundle:${jobId}`, data: '{"any":2}', owner: ownerOf(otherBuyer) },
    [locator(73)]: { name: `dacs3:agreement:${jobId}`, data: JSON.stringify(await agreementFor(jobId, 2, 1)), owner: ownerOf(otherBuyer) },
  }, [locator(70), locator(71), locator(72), locator(73)]);
  await reindex();
  const deals = store.loadCatalog().sellers.find((s) => s.primaryClaim === seller)?.deals ?? [];
  assert.deepEqual(deals.map((deal) => `${deal.owners.buyer} ${deal.buyerBundleRef}`).sort(),
    [`${buyer} ${locator(70)}`, `${otherBuyer} ${locator(72)}`].sort());
  // Verified-deal deduplication keeps one record per buyer and jobId, and per bundle ref.
  const verifiedDeal = (who: string, at: number) => ({ jobId, rail: "pay-dem", buyerBundleRef: locator(at),
    owners: { buyer: who, seller }, signatureVerified: true, refsVerified: true, verifiedAt: 1 });
  assert.deepEqual(dedupeVerifiedDeals([verifiedDeal(buyer, 70), verifiedDeal(otherBuyer, 72), verifiedDeal(buyer, 74), verifiedDeal(outsider, 70)])
    .map((deal) => deal.buyerBundleRef), [locator(70), locator(72)]);
});

test("v9 scan state is completed by a full deal-history replay before it is marked migrated", async () => {
  const jobId = "stored-job";
  resetIndex([later], 8);
  chain({
    [locator(45)]: { name: `dacs5:bundle:${jobId}`, data: '{"any":1}', owner: ownerOf(buyer) },
    [locator(46)]: { name: `dacs3:agreement:${jobId}`, data: JSON.stringify(await agreementFor(jobId, 0, 1)), owner: ownerOf(buyer) },
    [locator(47)]: { name: `dacs5:bundle:${jobId}`, data: '{"any":2}', owner: ownerOf(otherBuyer) },
    [locator(48)]: { name: `dacs3:agreement:${jobId}`, data: JSON.stringify(await agreementFor(jobId, 2, 3)), owner: ownerOf(otherBuyer) },
  }, [locator(45), locator(46), locator(47), locator(48)]);
  transactions.unshift(memo(30));
  // jobId-keyed v9 state in which only one owner's entry was kept.
  const kept = { jobId, rail: "pay-dem", buyerBundleRef: locator(47), owners: { buyer: otherBuyer, seller: otherSeller }, sellerFromAgreement: otherSeller };
  sql("UPDATE kv_state SET value_json=? WHERE key='scan-state'", JSON.stringify({ ...emptyState(), lastSeenTxId: 30, deals: { [jobId]: kept } }));
  const entries = () => Object.values(store.loadScanState().deals).filter((deal) => deal.jobId === jobId).map((deal) => deal.owners.buyer).sort();
  // An interrupted replay leaves the state unmigrated, and the next pass replays again.
  nodeDown = true;
  try { await assert.rejects(reindex()); } finally { nodeDown = false; }
  assert.equal(store.loadScanState().schemaVersion, 9);
  assert.deepEqual(entries(), [otherBuyer]);
  // An entry whose bundle cannot be read during the replay is kept, not dropped.
  unavailable.add(locator(47));
  await reindex();
  unavailable.clear();
  assert.equal(lastRun().from_tx, 0, "a replay from genesis");
  assert.equal(store.loadScanState().schemaVersion, 10);
  assert.deepEqual(entries(), [buyer, otherBuyer].sort());
  assert.deepEqual(store.loadCatalog().sellers.find((s) => s.primaryClaim === seller)?.deals.map((d) => d.buyerBundleRef), [locator(45)]);
  // Once migrated, passes are incremental and the result is unchanged.
  await reindex();
  assert.equal(lastRun().from_tx, 28);
  assert.deepEqual(entries(), [buyer, otherBuyer].sort());
  const saved = JSON.parse(String(sql("SELECT value_json FROM kv_state WHERE key='scan-state'")[0].value_json)) as ScanState;
  assert.deepEqual(Object.keys(saved.deals).sort(), [`${ownerOf(buyer)}\n${jobId}`, `${ownerOf(otherBuyer)}\n${jobId}`].sort());
});

test("a discovered deal keeps its seller copy when a later window has none", async () => {
  const jobId = "kept-copy";
  resetIndex([later], 23);
  chain({
    [locator(920)]: { name: `dacs5:bundle:${jobId}`, data: '{"any":1}', owner: ownerOf(buyer) },
    [locator(921)]: { name: `dacs3:agreement:${jobId}`, data: JSON.stringify(await agreementFor(jobId, 0, 1)), owner: ownerOf(buyer) },
    [locator(922)]: { name: `dacs5:bundle:seller:${jobId}`, data: '{"any":1}', owner: ownerOf(seller) },
  }, [locator(920), locator(921), locator(922)]);
  transactions.unshift(memo(10));
  await reindex();
  const entry = () => store.loadScanState().deals[`${ownerOf(buyer)}\n${jobId}`];
  assert.equal(entry().sellerBundleRef, locator(922));
  transactions = [memo(40, locator(920))];
  await reindex();
  assert.equal(entry().owners.seller, seller);
  assert.equal(entry().sellerBundleRef, locator(922));
});

/** Records each locator as read with `who` as its storage owner. */
const owns = (who: string, ...at: number[]) => {
  for (const n of at) store.recordArtifact({ locator: locator(n), kind: "bundle", profile: "unknown", owner: ownerOf(who), observedAt: 1 });
};
const ownersLookup = (jobId: string) => async (query = "") =>
  await (await dealOwnersRoute.GET(new NextRequest(`http://localhost/api/dacs/deal-owners?jobId=${jobId}${query}`))).json();

test("deal-owner lookup answers only when one attributed deal holds the jobId", async () => {
  const jobId = "lookup-job";
  const entry = (who: string, sellerClaim: string, at: number) =>
    ({ jobId, rail: "pay-dem", buyerBundleRef: locator(at), owners: { buyer: who, seller: sellerClaim } });
  const lookup = async (query = "") =>
    await (await dealOwnersRoute.GET(new NextRequest(`http://localhost/api/dacs/deal-owners?jobId=${jobId}${query}`))).json();
  const verified = (deal: ReturnType<typeof entry>) => ({ ...deal, refsVerified: true });
  const catalogOf = (...records: Array<[string, Array<ReturnType<typeof entry> & { refsVerified?: boolean; sellerBundleRef?: string }>]>) => store.saveCatalog({ catalogVersion: "1", generatedAt: 1,
    sellers: records.map(([claim, deals]) => ({ primaryClaim: claim,
      deals: deals.map((deal) => ({ signatureVerified: false, refsVerified: false, verifiedAt: 1, ...deal })) })) as never });
  resetIndex([later], 14);
  owns(buyer, 46, 56);
  owns(outsider, 47);
  owns(otherBuyer, 48);
  // Scanned entries only: an attributed entry next to another owner's unattributed one is ambiguous.
  store.saveScanState({ ...emptyState(), deals: { a: entry(buyer, seller, 46), b: entry(outsider, "", 47) } });
  assert.equal((await lookup()).owners, null);
  store.saveScanState({ ...emptyState(), deals: { a: entry(buyer, seller, 46) } });
  assert.deepEqual((await lookup()).owners, { buyer, seller });
  // A lone unattributed entry is not reported as ownership.
  store.saveScanState({ ...emptyState(), deals: { b: entry(outsider, "", 47) } });
  assert.deepEqual(await lookup(), { owners: null, buyerBundleRef: null });
  // A verified catalog entry stands for its own scanned entry, whose refs may differ.
  store.saveScanState({ ...emptyState(), deals: { a: entry(buyer, seller, 46) } });
  catalogOf([seller, [verified(entry(buyer, seller, 56))]]);
  assert.deepEqual(await lookup(), { owners: { buyer, seller }, buyerBundleRef: locator(56), sellerBundleRef: null });
  // An unverified one does not when its ref is neither the scanned ref nor bound by a binding.
  const scannedDeal = { owners: { buyer, seller }, buyerBundleRef: locator(46), sellerBundleRef: null };
  catalogOf([seller, [entry(buyer, seller, 56)]]);
  assert.deepEqual(await lookup(), scannedDeal);
  // Nor does a verified one with a ref its party does not hold, or one in another seller's record.
  catalogOf([seller, [verified(entry(buyer, seller, 47))]]);
  assert.deepEqual(await lookup(), scannedDeal);
  catalogOf([seller, [{ ...verified(entry(buyer, seller, 46)), sellerBundleRef: locator(47) }]]);
  assert.deepEqual(await lookup(), scannedDeal);
  catalogOf([otherSeller, [verified(entry(buyer, seller, 56))]]);
  assert.deepEqual(await lookup(), scannedDeal);
  // Nor an unverified one naming the scanned buyer's ref under another seller.
  catalogOf([otherSeller, [entry(buyer, otherSeller, 46)]]);
  assert.deepEqual(await lookup(), scannedDeal);
  // Two catalog sellers' deals with the jobId are ambiguous unless the bundle names one.
  catalogOf([seller, [entry(buyer, seller, 46)]], [otherSeller, [verified(entry(otherBuyer, otherSeller, 48))]]);
  assert.equal((await lookup()).owners, null);
  assert.deepEqual((await lookup(`&bundleRef=${locator(48)}`)).owners, { buyer: otherBuyer, seller: otherSeller });
});

test("a seller copy belongs only to a deal whose attributed seller owns it", async () => {
  const jobId = "copy-owner";
  resetIndex([later], 24);
  chain({
    [locator(930)]: { name: `dacs5:bundle:${jobId}`, data: '{"any":1}', owner: ownerOf(buyer) },
    [locator(931)]: { name: `dacs3:agreement:${jobId}`, data: JSON.stringify(await agreementFor(jobId, 0, 1)), owner: ownerOf(buyer) },
    [locator(932)]: { name: `dacs5:bundle:seller:${jobId}`, data: '{"any":1}', owner: ownerOf(seller) },
  }, [locator(930), locator(931), locator(932)]);
  transactions.unshift(memo(10));
  await reindex();
  const lookup = ownersLookup(jobId);
  const deal = { owners: { buyer, seller }, buyerBundleRef: locator(930), sellerBundleRef: locator(932) };
  assert.deepEqual(await lookup(`&bundleRef=${locator(932)}`), deal);
  // Another owner's name-only bundle for the jobId, in the same window as the seller copy.
  storage[locator(933)] = { name: `dacs5:bundle:${jobId}`, data: '{"any":9}', owner: ownerOf(outsider) };
  transactions = [memo(20, `${locator(933)} ${locator(932)}`), ...transactions];
  const entryOf = (did: string) => store.loadScanState().deals[`${ownerOf(did)}\n${jobId}`];
  const window = await scanChain(null, { maxTxs: 100, sinceTxId: 0 });
  const scannedOf = (did: string) => [...window.deals.values()].find((deal) => deal.jobId === jobId && deal.owners.buyer === did);
  assert.equal(scannedOf(outsider)?.sellerBundleRef, undefined);
  assert.equal(scannedOf(buyer)?.sellerBundleRef, locator(932));
  for (let pass = 1; pass <= 3; pass++) {
    await reindex();
    transactions = [];
    assert.equal(entryOf(outsider).owners.seller, "");
    assert.equal(entryOf(outsider).sellerBundleRef, undefined, `pass ${pass}`);
    assert.deepEqual(await lookup(`&bundleRef=${locator(932)}`), deal, `pass ${pass}`);
    assert.deepEqual(await lookup(`&bundleRef=${locator(930)}`), deal, `pass ${pass}`);
  }
  // State saved by an earlier release can still carry a copy on the unattributed entry:
  // the lookup does not count it, and the next pass removes it.
  const unfiltered = await lookup();
  const state = store.loadScanState();
  state.deals[`${ownerOf(outsider)}\n${jobId}`].sellerBundleRef = locator(932);
  store.saveScanState(state);
  assert.deepEqual(await lookup(`&bundleRef=${locator(932)}`), deal);
  assert.deepEqual(await lookup(), unfiltered);
  await reindex();
  assert.equal(entryOf(outsider).sellerBundleRef, undefined);
});

test("deal-owner lookup counts a deal only when its bundle refs are bound to its parties", async () => {
  const jobId = "declared-job";
  const declared = (buyerRef: number, sellerRef: number, owners = { buyer, seller }) =>
    ({ jobId, rail: "pay-dem", buyerBundleRef: locator(buyerRef), sellerBundleRef: locator(sellerRef), owners });
  const thirdParty: Registration = { primaryClaim: otherSeller, displayName: "Third party", listingAnchors: [], deals: [declared(943, 944)] };
  resetIndex([thirdParty, later], 25);
  chain({
    [locator(940)]: { name: `dacs5:bundle:${jobId}`, data: '{"any":1}', owner: ownerOf(buyer) },
    [locator(941)]: { name: `dacs3:agreement:${jobId}`, data: JSON.stringify(await agreementFor(jobId, 0, 1)), owner: ownerOf(buyer) },
    [locator(942)]: { name: `dacs5:bundle:seller:${jobId}`, data: '{"any":1}', owner: ownerOf(seller) },
    [locator(943)]: { data: '{"any":2}', owner: ownerOf(otherSeller) },
    [locator(944)]: { data: '{"any":3}', owner: ownerOf(otherSeller) },
  }, [locator(940), locator(941), locator(942), locator(943), locator(944)]);
  transactions.unshift(memo(10));
  await reindex();
  const lookup = ownersLookup(jobId);
  const deal = { owners: { buyer, seller }, buyerBundleRef: locator(940), sellerBundleRef: locator(942) };
  const catalogRefs = () => store.loadCatalog().sellers.flatMap((s) => s.deals).filter((d) => d.jobId === jobId).map((d) => d.buyerBundleRef).sort();
  assert.deepEqual(catalogRefs(), [locator(940), locator(943)], "the registration's deal is in the catalog");
  // The registration's refs are owned by neither named party.
  assert.deepEqual(await lookup(`&bundleRef=${locator(944)}`), { owners: null, buyerBundleRef: null });
  assert.deepEqual(await lookup(`&bundleRef=${locator(940)}`), deal);
  assert.deepEqual(await lookup(`&bundleRef=${locator(942)}`), deal);
  assert.deepEqual(await lookup(), deal);
  // A registration that names the buyer's bundle under other parties is not counted either.
  store.saveRegistrations([{ ...thirdParty, deals: [declared(940, 944, { buyer: otherBuyer, seller: otherSeller })] }, later]);
  transactions = [];
  await reindex();
  assert.deepEqual(await lookup(`&bundleRef=${locator(940)}`), deal);
  // Nor one that pairs the buyer's bundle with a seller copy the seller does not own.
  store.saveRegistrations([{ ...thirdParty, deals: [declared(940, 944)] }, later]);
  await reindex();
  assert.ok(catalogRefs().filter((ref) => ref === locator(940)).length === 2, "both deals are in the catalog");
  assert.deepEqual(await lookup(`&bundleRef=${locator(944)}`), { owners: null, buyerBundleRef: null });
  assert.deepEqual(await lookup(`&bundleRef=${locator(940)}`), deal);
});

test("a registration's deal counts for the lookup only when verified or when it is the scanned deal as indexed", async () => {
  const jobId = "registered-job";
  const real = { owners: { buyer, seller }, buyerBundleRef: locator(960), sellerBundleRef: locator(962) };
  const declared = (buyerRef: number, sellerRef?: number, owners = { buyer, seller }) => ({ jobId, rail: "pay-dem",
    buyerBundleRef: locator(buyerRef), ...(sellerRef ? { sellerBundleRef: locator(sellerRef) } : {}), owners });
  const signedBy = async (reg: Registration, signer: number): Promise<Registration> => {
    const signedAt = Date.now();
    const message = registrationMessage(reg, signedAt);
    const value = Buffer.from(await ed25519Sign(Buffer.from(message), privateKeyFromSeed(seeds[signer]))).toString("hex");
    return { ...reg, ownerSignature: { message, signature: value, signedAt } };
  };
  const lookupsWith = async (registration: Registration) => {
    resetIndex([registration, later], 27);
    chain({
      [locator(960)]: { name: `dacs5:bundle:${jobId}`, data: '{"any":1}', owner: ownerOf(buyer) },
      [locator(961)]: { name: `dacs3:agreement:${jobId}`, data: JSON.stringify(await agreementFor(jobId, 0, 1)), owner: ownerOf(buyer) },
      [locator(962)]: { name: `dacs5:bundle:seller:${jobId}`, data: '{"any":1}', owner: ownerOf(seller) },
    }, [locator(960), locator(961), locator(962)]);
    transactions.unshift(memo(10));
    await reindex();
    const lookup = ownersLookup(jobId);
    return [await lookup(`&bundleRef=${locator(960)}`), await lookup(`&bundleRef=${locator(962)}`), await lookup()];
  };
  const thirdParty = (deal: ReturnType<typeof declared>): Registration =>
    ({ primaryClaim: otherSeller, displayName: "Third party", listingAnchors: [], deals: [deal] });
  // Another party's registration naming the scanned deal's parties or refs, signed by that party or not.
  for (const registration of [
    thirdParty(declared(960)),
    thirdParty(declared(961, 962)),
    thirdParty(declared(960, undefined, { buyer, seller: otherSeller })),
    await signedBy(thirdParty(declared(960, undefined, { buyer, seller: otherSeller })), 3),
  ]) {
    assert.deepEqual(await lookupsWith(registration), [real, real, real], JSON.stringify(registration.deals));
  }
  assert.equal(store.loadCatalog().sellers.find((s) => s.primaryClaim === otherSeller)?.ownerRegistered, true);
  // An unsigned registration under the seller's own claim whose refs differ from the scanned deal's.
  for (const deal of [declared(961, 962), declared(960)]) {
    assert.deepEqual(await lookupsWith({ primaryClaim: seller, displayName: "Seller", listingAnchors: [], deals: [deal] }),
      [real, real, real], JSON.stringify(deal));
  }
});

test("deal-owner lookup by bundleRef never reports a scanned ref the catalog has resolved past", async () => {
  const jobId = "resolved-ref";
  resetIndex([later], 26);
  const scanned = { jobId, rail: "pay-dem", buyerBundleRef: locator(950), owners: { buyer, seller } };
  owns(buyer, 950);
  // The catalog's buyer ref comes from the buyer's verified BundleBinding.
  const scope = { bindingVersion: "1", jobId, role: "buyer", logicalAddress: logicalBundleAddress(jobId, "buyer"),
    nativeAddress: locator(951), bundleContentHash: "c".repeat(64), signer: buyer };
  const binding = { ...scope, signature: { algorithm: "ed25519", signer: buyer,
    value: await signature(contentHash(scope), "dacs-bundle-binding:v1:", 0, "base64url") } } as BundleBinding;
  assert.ok(await verifyBundleBinding(binding));
  store.saveScanState({ ...emptyState(), schemaVersion: 10, deals: { [`${ownerOf(buyer)}\n${jobId}`]: scanned }, bundleBindings: { [jobId]: [binding] } });
  store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [{ primaryClaim: seller,
    deals: [{ ...scanned, buyerBundleRef: locator(951), signatureVerified: true, refsVerified: true, verifiedAt: 1 }] }] } as never);
  const lookup = ownersLookup(jobId);
  const resolved = { owners: { buyer, seller }, buyerBundleRef: locator(951), sellerBundleRef: null };
  assert.deepEqual(await lookup(), resolved);
  assert.deepEqual(await lookup(`&bundleRef=${locator(951)}`), resolved);
  assert.deepEqual(await lookup(`&bundleRef=${locator(950)}`), { owners: null, buyerBundleRef: null });
  // So does a catalog entry the indexer could not verify, resolved through the same binding.
  const catalog = store.loadCatalog();
  catalog.sellers[0].deals[0].refsVerified = false;
  store.saveCatalog(catalog);
  assert.deepEqual(await lookup(), resolved);
  assert.deepEqual(await lookup(`&bundleRef=${locator(950)}`), { owners: null, buyerBundleRef: null });
  // The buyer's binding for the seller role does not bind the catalog's buyer ref.
  const sellerScope = { ...scope, role: "seller", logicalAddress: logicalBundleAddress(jobId, "seller") };
  const sellerRole = { ...sellerScope, signature: { algorithm: "ed25519", signer: buyer,
    value: await signature(contentHash(sellerScope), "dacs-bundle-binding:v1:", 0, "base64url") } } as BundleBinding;
  assert.ok(await verifyBundleBinding(sellerRole));
  store.saveScanState({ ...store.loadScanState(), bundleBindings: { [jobId]: [sellerRole] } });
  assert.deepEqual(await lookup(`&bundleRef=${locator(951)}`), { owners: null, buyerBundleRef: null });
});

test("a locator whose content was rejected stays periodic after later transient failures", () => {
  resetIndex([later], 9);
  const at = locator(500);
  for (let pass = 0; pass < 4; pass++) {
    store.recordArtifact({ locator: at, kind: "other", profile: "unknown", observedAt: Date.now(), rejected: true });
    store.recordArtifactFailure(at, "other", "ARTIFACT_REJECTED", "rejected", 1);
  }
  for (let attempt = 1; attempt <= 7; attempt++) {
    store.recordArtifactFailure(at, "unknown", "STORAGE_RPC_UNAVAILABLE", "outage", 5);
    const row = sql("SELECT status, next_retry_at FROM artifacts WHERE locator=?", at)[0];
    assert.equal(row.status, "retry", `transient failure ${attempt}`);
    assert.ok(Number(row.next_retry_at) > 0);
  }
  assert.equal(sql("SELECT COUNT(*) count FROM dead_letters WHERE locator=?", at)[0].count, 0);
  assert.deepEqual(sql("SELECT retry_count, rejection_count FROM artifacts WHERE locator=?", at)[0], { retry_count: 7, rejection_count: 4 });
  // A locator that only ever failed transiently keeps the bounded transient policy.
  const transient = locator(501);
  for (let attempt = 0; attempt < 5; attempt++) store.recordArtifactFailure(transient, "unknown", "STORAGE_RPC_UNAVAILABLE", "outage", 5);
  assert.equal(sql("SELECT status FROM artifacts WHERE locator=?", transient)[0].status, "dead-letter");
});

test("a pass reads at most 100 retries with transient failures first and at most 20 rejected", () => {
  resetIndex([later], 16);
  const transient = range(800, 120), rejected = range(950, 30);
  for (const at of rejected) store.recordArtifactFailure(at, "other", "ARTIFACT_REJECTED", "rejected", 1);
  for (const at of transient) store.recordArtifactFailure(at, "unknown", "STORAGE_RPC_UNAVAILABLE", "outage", 5);
  const due = Date.now() + 4_000_000;
  const full = store.loadRetryableArtifacts(due);
  assert.deepEqual(full.slice(0, 80), transient.slice(0, 80));
  assert.equal(full.length, 100);
  assert.ok(full.slice(80).every((at) => rejected.includes(at)));
  // Transient retries fill whatever the rejected share does not use.
  sql(`DELETE FROM artifacts WHERE locator IN (${rejected.slice(0, 25).map(() => "?").join(",")})`, ...rejected.slice(0, 25));
  const mixed = store.loadRetryableArtifacts(due);
  assert.deepEqual(mixed.slice(0, 95), transient.slice(0, 95));
  assert.deepEqual(mixed.slice(95).sort(), rejected.slice(25).sort());
});

test("rejected retries keep a reserved share while transient retries are due", () => {
  resetIndex([later], 20);
  const transient = range(8_000, 100), rejected = locator(8_500);
  store.recordArtifactFailure(rejected, "other", "ARTIFACT_REJECTED", "rejected", 1);
  for (const at of transient) store.recordArtifactFailure(at, "unknown", "STORAGE_RPC_UNAVAILABLE", "outage", 5);
  assert.deepEqual(store.loadRetryableArtifacts(Date.now() + 4_000_000), [...transient.slice(0, 99), rejected]);
});

test("content that fails the artifact policy on a well-formed read is a rejection", async () => {
  resetIndex([later], 21);
  const named = locator(900), longName = locator(901);
  chain({ [named]: { data: "[1,2]", name: "dacs5:bundle:bad" }, [longName]: { data: "{}", name: `dacs1:listing:${"x".repeat(1_100)}` } },
    [named, longName]);
  await reindex();
  for (const at of [named, longName]) {
    assert.deepEqual(sql("SELECT error_code, rejection_count, retry_count FROM artifacts WHERE locator=?", at)[0],
      { error_code: "ARTIFACT_REJECTED", rejection_count: 1, retry_count: 0 }, at);
  }
  assert.equal(reads.get(named), 1, "content is not read again within the same pass");
});

test("a successful read without content ends the rejected class", async () => {
  resetIndex([later], 22);
  const at = locator(910);
  chain({ [at]: { data: '{"n":1e400}' } }, [at]);
  await reindex();
  assert.equal(sql("SELECT rejection_count FROM artifacts WHERE locator=?", at)[0].rejection_count, 1);
  transactions = [];
  sql("UPDATE artifacts SET next_retry_at=0 WHERE locator=?", at);
  await reindex();
  assert.equal(sql("SELECT rejection_count FROM artifacts WHERE locator=?", at)[0].rejection_count, 2, "rejections accumulate");
  storage[at] = { data: '"text"' };
  sql("UPDATE artifacts SET next_retry_at=0 WHERE locator=?", at);
  await reindex();
  assert.deepEqual(sql("SELECT status, rejection_count, retry_count FROM artifacts WHERE locator=?", at)[0],
    { status: "observed", rejection_count: 0, retry_count: 0 });
  // A later outage follows the bounded transient policy.
  for (let attempt = 0; attempt < 5; attempt++) store.recordArtifactFailure(at, "unknown", "STORAGE_RPC_UNAVAILABLE", "outage", 5);
  assert.equal(sql("SELECT status FROM artifacts WHERE locator=?", at)[0].status, "dead-letter");
});

test("a transient retry is read before rejected retries and the revocation it carries is applied", async () => {
  resetIndex([sellerRegistration, later], 10);
  chain({ [locator(1)]: { data: JSON.stringify(listing) }, [locator(60)]: { data: JSON.stringify(marker) } }, [locator(1), locator(60)]);
  const rejected = range(700, 150);
  for (const at of rejected) {
    store.recordArtifact({ locator: at, kind: "other", profile: "unknown", observedAt: Date.now(), rejected: true });
    store.recordArtifactFailure(at, "other", "ARTIFACT_REJECTED", "rejected", 1);
  }
  unavailable.add(locator(60));
  await reindex();
  assert.equal(listingStatus(), "active");
  // The marker's write is now outside the scan window; only its retry can read it again.
  unavailable.clear();
  transactions = [];
  reads = new Map();
  sql("UPDATE artifacts SET next_retry_at=0 WHERE error_code='ARTIFACT_REJECTED'");
  sql("UPDATE artifacts SET next_retry_at=1 WHERE locator=?", locator(60));
  await reindex();
  assert.equal(listingStatus(), "revoked");
  assert.ok(readsOf(rejected) <= 20, `rejected retries read ${readsOf(rejected)}`);
});

test("scheduled rejected retries have a ceiling and every waiting locator is still retried", () => {
  resetIndex([later], 11);
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const total = 1_030;
    const rejected = range(5_000, total);
    const reject = (at: string) => {
      store.recordArtifact({ locator: at, kind: "other", profile: "unknown", observedAt: clock, rejected: true });
      store.recordArtifactFailure(at, "other", "ARTIFACT_REJECTED", "rejected", 1);
    };
    for (const at of rejected) reject(at);
    const served = new Set<string>();
    let rounds = 0;
    while (served.size < total && rounds < 80) {
      clock += 15 * 60_000;
      rounds++;
      const batch = store.loadRetryableArtifacts();
      assert.ok(batch.length <= 20, `round ${rounds} read ${batch.length} rejected locators`);
      for (const at of batch) { served.add(at); reject(at); }
    }
    assert.equal(served.size, total, "no waiting locator is dropped");
    assert.ok(rounds <= Math.ceil(total / 20) + 2, `all served after ${rounds} rounds`);
    const active = Number(sql("SELECT COUNT(*) count FROM artifacts WHERE rejection_count > 0 AND deferred_at IS NULL")[0].count);
    const waiting = Number(sql("SELECT COUNT(*) count FROM artifacts WHERE rejection_count > 0 AND deferred_at IS NOT NULL")[0].count);
    assert.ok(active <= 1_000, `${active} scheduled`);
    assert.equal(active + waiting, total);
    // Slots freed by recovered locators go to the longest-waiting ones on the next pass.
    const recovered = (sql("SELECT locator FROM artifacts WHERE rejection_count > 0 AND deferred_at IS NULL LIMIT 10")).map((row) => String(row.locator));
    for (const at of recovered) store.recordArtifact({ locator: at, kind: "other", profile: "unknown", contentHash: "e".repeat(64), observedAt: clock });
    store.loadRetryableArtifacts();
    assert.equal(Number(sql("SELECT COUNT(*) count FROM artifacts WHERE rejection_count > 0 AND deferred_at IS NOT NULL")[0].count), waiting - 10);
  } finally { Date.now = realNow; }
});

test("a stored registration over the binding limit is refused before its bindings are verified", async () => {
  const scope = { bindingVersion: "1", jobId: "job", role: "buyer", logicalAddress: logicalBundleAddress("job", "buyer"),
    nativeAddress: locator(10), bundleContentHash: "c".repeat(64), signer: buyer };
  const invalid = { ...scope, signature: { algorithm: "ed25519", signer: buyer, value: "A".repeat(86) } } as BundleBinding;
  resetIndex([{ primaryClaim: buyer, displayName: "Over limit", listingAnchors: [], bundleBindings: Array(300).fill(invalid) }, later], 12);
  chain({}, []);
  await reindex();
  assert.deepEqual(store.loadCatalog().sellers.map((s) => s.displayName), ["Later"]);
  assert.equal(lastRun().omitted_sellers, 1);
  assert.equal(lastRun().omitted_bindings, 0, "no binding of a refused registration is verified");
});

const resolverName = "dacs1:listing:bounded";
const candidateSearch = () => Response.json({ result: 200, response: [{ storageAddress: locator(70), programName: resolverName }] });
let cancelledStreams = 0;
/** A valid JSON body padded past the response ceiling. */
function padded(head: string, tail: string) {
  let sent = 0;
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    pull(controller) {
      if (sent === 0) controller.enqueue(encoder.encode(head));
      const bytes = new Uint8Array(16_384).fill(32);
      controller.enqueue(bytes);
      sent += bytes.length;
      if (sent > 1_100_000) { controller.enqueue(encoder.encode(tail)); controller.close(); }
    },
    cancel() { cancelledStreams++; },
  }));
}
const resolverCases: Array<[string, typeof fetch, boolean]> = [
  ["search response", async () => padded('{"result":200,"response":[]', "}"), true],
  ["candidate response", async (input) => String(input).includes("/storage-program/")
    ? padded(`{"success":true,"owner":"${ownerOf(seller)}","programName":"${resolverName}","data":{"blob":"`, '"}}')
    : candidateSearch(), true],
  ["candidate artifact", async (input) => String(input).includes("/storage-program/")
    ? new Response(JSON.stringify({ success: true, owner: ownerOf(seller), programName: resolverName, data: { blob: "x".repeat(300_000) } }))
    : candidateSearch(), false],
];
for (const [label, stub, streamed] of resolverCases) {
  test(`the producer-side program resolver bounds an oversized ${label}`, async () => {
    const original = globalThis.fetch;
    cancelledStreams = 0;
    globalThis.fetch = stub;
    try {
      assert.equal((await resolveOwnedAnchorByName(resolverName, ownerOf(seller))).status, "indeterminate");
      if (streamed) assert.equal(cancelledStreams, 1, "the response is cancelled rather than consumed");
    } finally { globalThis.fetch = original; }
  });
}

const duplicateJob = "dup-job", duplicateName = `dacs3:agreement:${duplicateJob}`;
function duplicateProgramState() {
  resetIndex([later], 13);
  store.saveScanState({ ...emptyState(), programs: { [store.programBindingKey(ownerOf(buyer), duplicateName)]: null } });
  return deriveAnchorAddress(buyer, duplicateName);
}

test("the artifact route reports an owner and name with duplicate programs as indeterminate", async () => {
  const derived = duplicateProgramState();
  const response = await artifactRoute.GET(new NextRequest(
    `http://localhost/api/dacs/artifact?owner=${ownerOf(buyer)}&name=${encodeURIComponent(duplicateName)}`));
  assert.equal(response.status, 409);
  assert.notEqual((await response.json()).ref, derived);
});

test("the indexer never reads the derived address of an owner and name with duplicate programs", async () => {
  const jobId = duplicateJob;
  const derived = duplicateProgramState();
  const bundle = { bundleVersion: "0.1", jobId, outcome: "completed", anchoredByRole: "buyer",
    listingRef: { listingId: "svc", version: 1, contentHash: listingHash },
    agreementRef: { kind: "dacs-3-agreement", id: "agreement", contentHash: "a".repeat(64) },
    parties: [{ role: "buyer", primaryClaim: buyer, bundleHash: "b" }, { role: "seller", primaryClaim: seller, bundleHash: "s" }],
    phaseSummary: [], vetRecords: [], settlementEvidence: [], recipeRegistryVersion: 1, railRegistryVersion: 1, finalisedAt: 1 };
  chain({ [locator(80)]: { data: JSON.stringify(bundle), owner: ownerOf(buyer) } }, []);
  const record = await indexRegistration({ primaryClaim: seller, displayName: "Seller", listingAnchors: [],
    deals: [{ jobId, rail: "pay-dem", buyerBundleRef: locator(80), owners: { buyer, seller } }] }, undefined, offline);
  assert.ok((reads.get(locator(80)) ?? 0) > 0, "the bundle itself was read");
  assert.equal(reads.get(derived) ?? 0, 0);
  assert.equal(record.deals[0].refsVerified, false);
});
