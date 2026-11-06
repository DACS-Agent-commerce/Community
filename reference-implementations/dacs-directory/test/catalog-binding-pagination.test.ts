import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { contentHash } from "../src/catalog/canonical.js";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { catalogBundleBindings, logicalBundleAddress } from "../src/catalog/bundleBinding.js";
import type { BundleBinding } from "../src/catalog/types.js";

const dataDirectory = mkdtempSync(join(tmpdir(), "catalog-binding-pages-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
process.env.DACS_SCAN_FINALITY_DEPTH = "0";
const store = await import("../src/catalog/store.js");
const { scanChain } = await import("../src/catalog/scan.js");
const { GET } = await import("../app/api/dacs/bundles/[jobId]/route.js");
const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; rmSync(dataDirectory, { recursive: true, force: true }); });

const jobId = "catalog-pages";
const seeds = [41, 42].map((n) => new Uint8Array(32).fill(n));
const signers = seeds.map((seed) => `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`);
const native = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;
function binding(n: number, signer = 0, job = jobId): BundleBinding {
  const scope = { bindingVersion: "1" as const, jobId: job, role: "buyer" as const,
    logicalAddress: logicalBundleAddress(job, "buyer"), nativeAddress: native(n), bundleContentHash: "a".repeat(64), signer: signers[signer] };
  return { ...scope, signature: { signer: signers[signer], algorithm: "ed25519",
    value: Buffer.from(ed25519Sign(Buffer.from(`dacs-bundle-binding:v1:${contentHash(scope)}`), privateKeyFromSeed(seeds[signer]))).toString("base64url") } };
}
const get = (query = "", job = jobId) => GET(new NextRequest(`https://directory.example/api/dacs/bundles/${job}?${query}`),
  { params: Promise.resolve({ jobId: job }) });

test("scan to persisted unauthenticated pages carries every valid binding regardless of signer", async () => {
  const valid = [...Array.from({ length: 40 }, (_, n) => binding(n + 1)), binding(80, 1)];
  const invalid = { ...binding(81), bundleContentHash: "b".repeat(64) };
  const entries = [...valid, valid[0], invalid, binding(90, 0, "other-job")];
  const programs = new Map(entries.map((value, n) => [native(100 + n), value]));
  const transactions = [...programs.keys()].map((address, n) => ({ id: n + 1, content: { memo: address } })).reverse();
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.startsWith("/storage-program/")) {
      const data = programs.get(path.slice("/storage-program/".length));
      assert.ok(data);
      return Response.json({ success: true, owner: `0x${data.signer.slice(-64)}`, programName: `binding-${path.slice(-40)}`, data });
    }
    const call = JSON.parse(String(init?.body)).params?.[0];
    assert.equal(call.message, "getTransactions");
    return Response.json({ result: 200, response: call.data.start === "latest" ? transactions : [] });
  };
  const scan = await scanChain(null, { maxTxs: 100, sinceTxId: 0 });
  assert.equal(scan.complete, true);
  assert.equal(scan.omittedBindings, 1);
  assert.equal(scan.bundleBindings.get(jobId)?.length, 41, "the scan retains more than 32 from one signer and the outsider");
  const carried = catalogBundleBindings([...scan.bundleBindings.get(jobId)!, ...valid].reverse());
  assert.equal(carried.bindings.length, 41, "duplicate publications are carried once");
  assert.deepEqual(carried.overflowKeys, [`${jobId}\nbuyer\n${signers[0]}`]);
  // Persist the scanner's complete output directly. reindexCore's inherited
  // accumulation cap is separate from the scanner and read endpoint under test.
  store.saveScanState({ schemaVersion: 10, lastSeenTxId: scan.highestTxId, listings: {}, deals: {},
    bundleBindings: Object.fromEntries(scan.bundleBindings), bundleBindingOverflow: [...scan.bundleBindingOverflow] });
  const readAll = async () => {
    const seen: BundleBinding[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const response = await get(`limit=7${cursor ? `&cursor=${cursor}` : ""}`);
      assert.equal(response.status, 200, "reads need no authorization header");
      const body = await response.json();
      assert.equal(body.total, 41);
      seen.push(...body.bindings);
      cursor = body.cursor;
      assert.ok(++pages <= 6, "pagination terminates");
    } while (cursor);
    assert.equal(pages, 6);
    return seen;
  };
  const first = await readAll();
  assert.deepEqual(first.map(contentHash).sort(), valid.map(contentHash).sort());
  assert.equal(new Set(first.map(contentHash)).size, 41);
  assert.ok(first.some((value) => value.signer === signers[1]), "outsider record remains visible");
  assert.deepEqual(await readAll(), first, "an unchanged snapshot yields identical pages");
  assert.deepEqual((await (await get(`cursor=${"f".repeat(64)}`)).json()).bindings, []);
  assert.deepEqual((await (await get("", "missing-job")).json()).bindings, []);
});

test("binding pages reject invalid limits, cursors and job lengths", async () => {
  for (const query of ["limit=0", "limit=201", "limit=1.5", "limit=NaN", "cursor=", "cursor=-1", "cursor=20", "cursor=Infinity",
    `cursor=${"A".repeat(64)}`, `cursor=${"a".repeat(63)}`, `cursor=${"a".repeat(65)}`])
    assert.equal((await get(query)).status, 400, query);
  for (const job of ["", "j".repeat(161)]) assert.equal((await get("", job)).status, 400);
});

/** Replaces the persisted catalog for one job, as a reindex pass does. */
function persistBindings(job: string, bindings: BundleBinding[]) {
  store.saveScanState({ schemaVersion: 10, lastSeenTxId: 0, listings: {}, deals: {}, bundleBindings: { [job]: bindings } });
}
const hashOrder = (bindings: BundleBinding[]) => bindings.map(contentHash).sort();
const servedHashes = (body: { bindings: BundleBinding[] }) => body.bindings.map(contentHash);
const PAGE_JOB = "catalog-keyset";

test("a default request returns every binding in the plain response", async () => {
  const all = [...Array.from({ length: 60 }, (_, n) => binding(n + 1, 0, PAGE_JOB)), binding(200, 1, PAGE_JOB)];
  persistBindings(PAGE_JOB, all);
  const response = await get("", PAGE_JOB);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["bindings"], "no paging envelope when no paging is requested");
  assert.deepEqual(servedHashes(body).sort(), hashOrder(all), "all 61 records; the order of a plain reply is unspecified");
});

/** Counts the calls a default (unpaged) GET makes to a node:crypto function. */
async function cryptoCallsOnDefaultGet(t: TestContext, name: "verify" | "createHash") {
  persistBindings(PAGE_JOB, Array.from({ length: 5 }, (_, n) => binding(n + 1, 0, PAGE_JOB)));
  const spy = t.mock.method(crypto, name);
  syncBuiltinESMExports();
  try {
    const body = await (await get("", PAGE_JOB)).json();
    assert.equal(body.bindings.length, 5);
    const plain = spy.mock.callCount();
    await get("limit=2", PAGE_JOB);
    return { plain, paged: spy.mock.callCount() - plain };
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
}

test("a default request does not verify any binding signature", async (t) => {
  const calls = await cryptoCallsOnDefaultGet(t, "verify");
  assert.equal(calls.plain, 0, "the store holds only verified bindings, so the route never calls the signature verifier");
  assert.equal(calls.paged, 0, "paged requests do not verify either");
});

test("a default request does not hash any binding, only paged requests do", async (t) => {
  const calls = await cryptoCallsOnDefaultGet(t, "createHash");
  assert.equal(calls.plain, 0, "the plain reply is served without content hashes");
  assert.ok(calls.paged >= 5, "a paged reply hashes the set to order it and form the cursor");
});

test("paging across a reindex between pages omits no record", async () => {
  const before = Array.from({ length: 30 }, (_, n) => binding(n + 1, 0, PAGE_JOB));
  persistBindings(PAGE_JOB, before);
  const first = await (await get("limit=10", PAGE_JOB)).json();
  assert.deepEqual(servedHashes(first), hashOrder(before).slice(0, 10));
  assert.equal(first.cursor, hashOrder(before)[9], "the cursor is the last content hash served");
  // The reindex drops three already-served records and adds records on both sides of the cursor.
  const dropped = new Set(first.bindings.slice(0, 3).map(contentHash));
  const added = Array.from({ length: 6 }, (_, n) => binding(100 + n, 0, PAGE_JOB));
  const after = [...before.filter((value) => !dropped.has(contentHash(value))), ...added];
  persistBindings(PAGE_JOB, after);
  const seen = servedHashes(first);
  let cursor: string | undefined = first.cursor;
  while (cursor) {
    const page: { bindings: BundleBinding[]; cursor?: string } = await (await get(`limit=10&cursor=${cursor}`, PAGE_JOB)).json();
    seen.push(...servedHashes(page));
    cursor = page.cursor;
  }
  const mustBeSeen = hashOrder(before).filter((hash) => hash > first.cursor && after.some((value) => contentHash(value) === hash));
  for (const hash of mustBeSeen) assert.ok(seen.includes(hash), `record ${hash} survived the reindex and was skipped`);
  assert.equal(new Set(seen).size, seen.length, "no record is served twice");
  assert.ok(added.some((value) => contentHash(value) > first.cursor), "the fixture adds records after the cursor");
  for (const value of added.filter((entry) => contentHash(entry) > first.cursor)) assert.ok(seen.includes(contentHash(value)));
});

test("cursor alone returns the rest after the cursor key", async () => {
  const all = Array.from({ length: 12 }, (_, n) => binding(n + 1, 0, PAGE_JOB));
  persistBindings(PAGE_JOB, all);
  const { cursor } = await (await get("limit=5", PAGE_JOB)).json();
  const rest = await (await get(`cursor=${cursor}`, PAGE_JOB)).json();
  assert.deepEqual(Object.keys(rest), ["bindings"]);
  assert.deepEqual(servedHashes(rest), hashOrder(all).slice(5));
});

test("a cursor key that no longer exists continues from the next key", async () => {
  const all = Array.from({ length: 12 }, (_, n) => binding(n + 1, 0, PAGE_JOB));
  persistBindings(PAGE_JOB, all);
  const { cursor } = await (await get("limit=5", PAGE_JOB)).json();
  persistBindings(PAGE_JOB, all.filter((value) => contentHash(value) !== cursor));
  const response = await get(`limit=100&cursor=${cursor}`, PAGE_JOB);
  assert.equal(response.status, 200, "a vanished cursor key is not an error");
  assert.deepEqual(servedHashes(await response.json()), hashOrder(all).slice(5));
});

test("scanner groups a large same-signer catalog with subquadratic comparison work", async (t) => {
  const count = 160;
  const entries = Array.from({ length: count }, (_, n) => binding(n + 1));
  const programs = new Map(entries.map((value, n) => [native(1000 + n), value]));
  const transactions = [...programs.keys()].map((address, n) => ({ id: n + 1, content: { memo: address } })).reverse();
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.startsWith("/storage-program/")) {
      const data = programs.get(path.slice("/storage-program/".length));
      assert.ok(data);
      return Response.json({ success: true, owner: `0x${data.signer.slice(-64)}`, programName: `binding-${path.slice(-40)}`, data });
    }
    const call = JSON.parse(String(init?.body)).params?.[0];
    assert.equal(call.message, "getTransactions");
    const start = call.data.start === "latest" ? count : call.data.start;
    return Response.json({ result: 200, response: transactions.filter((tx) => tx.id <= start).slice(0, call.data.limit) });
  };
  const compare = String.prototype.localeCompare;
  let comparisons = 0;
  t.mock.method(String.prototype, "localeCompare", function (this: string, ...args: Parameters<typeof compare>) {
    comparisons++;
    return compare.apply(this, args);
  });
  try {
    const scan = await scanChain(null, { maxTxs: count + 1 });
    assert.equal(scan.complete, true);
    assert.equal(scan.bundleBindings.get(jobId)?.length, count, "work limits must not truncate catalog carriage");
    assert.deepEqual([...scan.bundleBindingOverflow], [`${jobId}\nbuyer\n${signers[0]}`]);
    assert.ok(comparisons <= 8 * count * Math.ceil(Math.log2(count)),
      `comparison work must grow at most n log n; observed ${comparisons} for ${count} records`);
    t.mock.restoreAll();
    assert.deepEqual(scan.bundleBindings.get(jobId), catalogBundleBindings(entries).bindings, "batching preserves deterministic catalog order");
  } finally {
    t.mock.restoreAll();
    globalThis.fetch = originalFetch;
  }
});
