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
const { logicalBundleAddress } = await import("../src/catalog/bundleBinding.js");
const { artifactHash } = await import("../src/catalog/evidenceGraph.js");
const { indexRegistration } = await import("../src/catalog/indexer.js");
const { deriveAnchorAddress, resolveOwnedAnchorByName } = await import("../src/catalog/chain.js");
const { reindexAll } = await import("../src/catalog/reindexCore.js");
const { scanChain } = await import("../src/catalog/scan.js");
const artifactRoute = await import("../app/api/dacs/artifact/route.js");
const dealOwnersRoute = await import("../app/api/dacs/deal-owners/route.js");

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
function resetIndex(registrations: Registration[], generatedAt: number) {
  store.saveRegistrations(registrations);
  store.saveCatalog({ catalogVersion: "1", generatedAt, sellers: [] });
  store.saveScanState(emptyState());
  sql("DELETE FROM artifacts");
  sql("DELETE FROM dead_letters");
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
  const queued = store.loadScanState().revocations[listingHash] as string[];
  for (const at of unreadable) assert.ok(queued.includes(at), `${at} stays queued`);
  // Rejected candidates are not verified again.
  reads = new Map();
  await reindex();
  assert.equal(listingStatus(), "revoked");
  assert.equal(readsOf(older.slice(16)), 0);
  assert.ok(readsOf(candidates) <= 16);
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

test("jobId-keyed scan state loads and is rekeyed by owner without a history replay", async () => {
  const jobId = "stored-job";
  resetIndex([later], 8);
  const deal = { jobId, rail: "pay-dem", buyerBundleRef: locator(45), owners: { buyer, seller }, sellerFromAgreement: seller };
  sql("UPDATE kv_state SET value_json=? WHERE key='scan-state'", JSON.stringify({ ...emptyState(), lastSeenTxId: 30, deals: { [jobId]: deal } }));
  const loaded = store.loadScanState();
  assert.deepEqual(Object.keys(loaded.deals), [`${ownerOf(buyer)}\n${jobId}`]);
  chain({}, []);
  transactions = [memo(30)];
  await reindex();
  assert.equal(lastRun().status, "complete");
  assert.equal(lastRun().from_tx, 28, "an incremental pass, not a replay from genesis");
  assert.deepEqual(store.loadCatalog().sellers.find((s) => s.primaryClaim === seller)?.deals.map((d) => d.jobId), [jobId]);
  const saved = JSON.parse(String(sql("SELECT value_json FROM kv_state WHERE key='scan-state'")[0].value_json)) as ScanState;
  assert.deepEqual(Object.keys(saved.deals), [`${ownerOf(buyer)}\n${jobId}`]);
});

test("deal-owner lookup reports the one attributed entry for a jobId and nothing when entries disagree", async () => {
  const jobId = "lookup-job";
  const entry = (who: string, sellerClaim: string, at: number) =>
    ({ jobId, rail: "pay-dem", buyerBundleRef: locator(at), owners: { buyer: who, seller: sellerClaim } });
  const lookup = async () => (await (await dealOwnersRoute.GET(new NextRequest(`http://localhost/api/dacs/deal-owners?jobId=${jobId}`))).json()).owners;
  resetIndex([later], 14);
  store.saveScanState({ ...emptyState(), deals: { a: entry(buyer, seller, 46), b: entry(outsider, "", 47) } });
  assert.deepEqual(await lookup(), { buyer, seller });
  store.saveScanState({ ...emptyState(), deals: { a: entry(buyer, seller, 46), b: entry(otherBuyer, otherSeller, 48) } });
  assert.equal(await lookup(), null);
});

test("a locator whose content was rejected stays periodic after later transient failures", () => {
  resetIndex([later], 9);
  const at = locator(500);
  for (let pass = 0; pass < 4; pass++) {
    store.recordArtifact({ locator: at, kind: "other", profile: "unknown", observedAt: Date.now() });
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
  assert.deepEqual(store.loadRetryableArtifacts(due), transient.slice(0, 100));
  sql(`DELETE FROM artifacts WHERE locator IN (${transient.slice(0, 30).map(() => "?").join(",")})`, ...transient.slice(0, 30));
  const mixed = store.loadRetryableArtifacts(due);
  assert.deepEqual(mixed.slice(0, 90), transient.slice(30));
  assert.equal(mixed.length, 100);
  assert.ok(mixed.slice(90).every((at) => rejected.includes(at)));
});

test("a transient retry is read before rejected retries and the revocation it carries is applied", async () => {
  resetIndex([sellerRegistration, later], 10);
  chain({ [locator(1)]: { data: JSON.stringify(listing) }, [locator(60)]: { data: JSON.stringify(marker) } }, [locator(1), locator(60)]);
  const rejected = range(700, 150);
  for (const at of rejected) {
    store.recordArtifact({ locator: at, kind: "other", profile: "unknown", observedAt: Date.now() });
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
      store.recordArtifact({ locator: at, kind: "other", profile: "unknown", observedAt: clock });
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
