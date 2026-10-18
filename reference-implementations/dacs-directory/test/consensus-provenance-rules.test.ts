import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash } from "@kynesyslabs/dacs/canonical";

const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-consensus-rules-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
process.env.DACS_SCAN_FINALITY_DEPTH = "0";
const { storageWriteCandidate, scanConsensusAnchorBackfill, scanChain } = await import("../src/catalog/scan.js");
test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));
type Obj = Record<string, any>;
const locator = `stor-${"a".repeat(40)}`;
const hash = "b".repeat(64);
const payload = { bundleVersion: "1", jobId: "provenance", parties: [], anchoredByRole: "buyer" };
const envelope = { type: "storageProgram", to: locator, data: ["storageProgram", { operation: "WRITE_STORAGE", storageAddress: locator, data: payload }] };
const tx: Obj = { id: 1, status: "confirmed", type: "storageProgram", hash, blockNumber: 7, to: locator, content: envelope };
const block: Obj = { number: 7, status: "confirmed", content: { timestamp: 123, ordered_transactions: [hash] } };

async function mocked<T>(transactions: Obj[], blocks: Map<number, Obj>, fn: () => Promise<T>, stored = payload, programName = "opaque"): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("/storage-program/")) return Response.json({ success: true, owner: `0x${"1".repeat(64)}`, programName, data: stored });
    const call = JSON.parse(String(init?.body)).params[0];
    return Response.json({ result: 200, response: call.message === "getTransactions" ? transactions : blocks.get(call.data.blockNumber) ?? null });
  };
  try { return await fn(); } finally { globalThis.fetch = original; }
}

test("consensus provenance rejects malformed writes while CREATE and WRITE retain exact locator/content/hash", () => {
  const expected = { locator, contentHash: contentHash(payload), blockNumber: 7, transactionHash: hash };
  assert.deepEqual(storageWriteCandidate(tx), expected);
  assert.deepEqual(storageWriteCandidate({ ...tx, content: JSON.stringify(envelope), hash: hash.toUpperCase() }), expected);
  const create = structuredClone(tx); create.content.data[1].operation = "CREATE_STORAGE_PROGRAM";
  assert.deepEqual(storageWriteCandidate(create), expected);
  const changes: Array<[string, (value: Obj) => void]> = [
    ["status", (v) => { v.status = "failed"; }], ["type", (v) => { v.type = "transfer"; }],
    ...[-1, 0.5, "7", null, Number.MAX_SAFE_INTEGER + 1].map((x): [string, (v: Obj) => void] => [`block ${x}`, (v) => { v.blockNumber = x; }]),
    ...[null, [hash], "c".repeat(63), `${hash}x`, `x${hash}`].map((x): [string, (v: Obj) => void] => [`hash ${x}`, (v) => { v.hash = x; }]),
    ["to type", (v) => { v.to = [locator]; }], ["to format", (v) => { v.to = locator + "a"; }],
    ["envelope null", (v) => { v.content = null; }], ["envelope array", (v) => { v.content = []; }],
    ["invalid JSON", (v) => { v.content = "{"; }], ["envelope type", (v) => { v.content.type = "transfer"; }],
    ["envelope target", (v) => { v.content.to = `stor-${"c".repeat(40)}`; }],
    ["data type", (v) => { v.content.data = {}; }], ["data length", (v) => { v.content.data.push({}); }],
    ["data tag", (v) => { v.content.data[0] = "transfer"; }], ["write type", (v) => { v.content.data[1] = []; }],
    ["operation", (v) => { v.content.data[1].operation = "DELETE_STORAGE_PROGRAM"; }],
    ["storage target", (v) => { v.content.data[1].storageAddress = "foreign"; }],
    ["stored array", (v) => { v.content.data[1].data = []; }], ["stored null", (v) => { v.content.data[1].data = null; }],
    ["stored noncanonical", (v) => { v.content.data[1].data = { fractional: 0.5 }; }],
  ];
  for (const [name, change] of changes) { const value = structuredClone(tx); change(value); assert.equal(storageWriteCandidate(value), null, name); }
  assert.deepEqual(storageWriteCandidate({ ...tx, blockNumber: 0 })?.blockNumber, 0);
});

test("anchor backfill requires confirmed block number, safe time and exact transaction membership", async () => {
  const target = new Map([[locator, contentHash(payload)]]);
  const scan = (b: Obj) => mocked([tx], new Map([[7, b]]), () => scanConsensusAnchorBackfill(target));
  assert.deepEqual((await scan(block)).observations, [{ locator, contentHash: contentHash(payload), anchorTime: 123000 }]);
  const changes: Array<[string, (value: Obj) => void]> = [
    ["status", (v) => { v.status = "pending"; }], ["number", (v) => { v.number = 8; }],
    ["number type", (v) => { v.number = "7"; }], ["content", (v) => { v.content = []; }],
    ...[-1, 0.5, "123", null, Number.MAX_SAFE_INTEGER].map((x): [string, (v: Obj) => void] => [`time ${x}`, (v) => { v.content.timestamp = x; }]),
    ["missing membership", (v) => { delete v.content.ordered_transactions; }],
    ["membership object", (v) => { v.content.ordered_transactions = {}; }],
    ["foreign hash", (v) => { v.content.ordered_transactions = ["c".repeat(64)]; }],
    ["non-string hash", (v) => { v.content.ordered_transactions = [[hash]]; }],
  ];
  for (const [name, change] of changes) { const b = structuredClone(block); change(b); assert.deepEqual((await scan(b)).observations, [], name); }
  assert.equal((await scan({ ...block, content: { timestamp: 0, ordered_transactions: [hash.toUpperCase()] } })).observations[0].anchorTime, 0);
});

test("current content cannot borrow an old payload's inclusion time and repeated writes choose the earliest block", async () => {
  const changed = { ...payload, jobId: "changed" };
  const scanned = await mocked([tx], new Map([[7, block]]), () => scanChain(null, { maxTxs: 1, sinceTxId: 0 }), changed);
  assert.equal(scanned.observations.find((item) => item.locator === locator)?.anchorTime, undefined);
  assert.equal(scanned.observations.find((item) => item.locator === locator)?.contentHash, contentHash(changed));
  const second = { ...tx, id: 2, blockNumber: 8, hash: "c".repeat(64) };
  const earlier = { number: 8, status: "confirmed", content: { timestamp: 100, ordered_transactions: [second.hash] } };
  for (const order of [[second, tx], [tx, second]]) {
    const result = await mocked(order, new Map([[7, block], [8, earlier]]), () => scanConsensusAnchorBackfill(new Map([[locator, contentHash(payload)]])));
    assert.deepEqual(result.observations, [{ locator, contentHash: contentHash(payload), anchorTime: 100000 }]);
  }
  const otherLocator = `stor-${"d".repeat(40)}`;
  const otherEnvelope = structuredClone(envelope); otherEnvelope.to = otherLocator;
  (otherEnvelope.data[1] as Obj).storageAddress = otherLocator;
  const distinct = { ...second, to: otherLocator, content: otherEnvelope };
  const result = await mocked([distinct, tx], new Map([[7, block], [8, earlier]]), () => scanConsensusAnchorBackfill(new Map([[locator, contentHash(payload)], [otherLocator, contentHash(payload)]])));
  assert.deepEqual(result.observations.sort((a, b) => a.locator.localeCompare(b.locator)), [
    { locator, contentHash: contentHash(payload), anchorTime: 123000 },
    { locator: otherLocator, contentHash: contentHash(payload), anchorTime: 100000 },
  ]);
});


test("current and legacy bundle observations receive only their matching authenticated inclusion time", async () => {
  for (const [legacy, role] of [[false, "buyer"], [true, "buyer"], [true, "seller"]] as const) {
    const stored = { ...payload, anchoredByRole: role, bundleVersion: legacy ? "0.1" : "1" };
    const content = structuredClone(envelope); (content.data[1] as Obj).data = stored;
    const transaction = { ...tx, content };
    const result = await mocked([transaction], new Map([[7, block]]), () => scanChain(null, { maxTxs: 1, sinceTxId: 0 }), stored,
      legacy ? `dacs5:bundle:${role === "seller" ? "seller:" : ""}provenance` : "opaque");
    const observed = result.observations.find((item) => item.locator === locator);
    assert.ok(observed);
    assert.equal(observed.anchorTime, 123000);
    assert.equal(observed.kind, "bundle");
    assert.equal(observed.profile, legacy ? "legacy-sdk-v0.1" : "dacs-v0.1");
    assert.equal(observed.contentHash, contentHash(stored));
  }
});
