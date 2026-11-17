import assert from "node:assert/strict";
import test from "node:test";

import { scanChain } from "../src/catalog/scan.js";
import { settledTip } from "../src/catalog/scanFinality.js";

const NOW = 1_800_000_000_000;
const SECOND = 1_000;
const HOUR = 3_600 * SECOND;
const owner = `0x${"1".repeat(64)}`;
const locatorOf = (digit: string) => `stor-${digit.repeat(40)}`;

/** A transfer that carries a storage locator in its memo, like the scanner's other fixtures. */
const transfer = (id: number, timestamp: unknown, locator = locatorOf("a")) => ({
  id, status: "confirmed", type: "transfer", hash: String(id % 10).repeat(64), blockNumber: id, to: "0x1",
  timestamp, content: JSON.stringify({ memo: locator }),
});

/** One scan against a stubbed node whose whole history fits in the first page. */
async function scanAt(
  transactions: unknown[],
  sinceTxId: number,
  env: { depth?: string; seconds?: string } = {},
) {
  const originalFetch = globalThis.fetch;
  const saved = { depth: process.env.DACS_SCAN_FINALITY_DEPTH, seconds: process.env.DACS_SCAN_FINALITY_SECONDS };
  process.env.DACS_SCAN_FINALITY_DEPTH = env.depth ?? "2";
  if (env.seconds === undefined) delete process.env.DACS_SCAN_FINALITY_SECONDS;
  else process.env.DACS_SCAN_FINALITY_SECONDS = env.seconds;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.startsWith("/storage-program/")) {
      return new Response(
        `{"success":true,"owner":"${owner}","programName":"opaque","data":{"note":"plain"}}`,
        { headers: { "content-type": "application/json" } },
      );
    }
    const call = JSON.parse(String(init?.body)).params?.[0];
    const response = call?.message === "getTransactions" && call.data?.start === "latest" ? transactions : null;
    return Response.json({ result: 200, response });
  };
  try {
    return await scanChain(null, { maxTxs: 100, sinceTxId, now: NOW });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [["DACS_SCAN_FINALITY_DEPTH", saved.depth], ["DACS_SCAN_FINALITY_SECONDS", saved.seconds]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("a quiet chain indexes its newest transactions once they are old enough", async () => {
  const result = await scanAt([
    transfer(1270, NOW - 7 * HOUR, locatorOf("c")),
    transfer(1269, NOW - 8 * HOUR),
    transfer(1268, NOW - 9 * HOUR),
  ], 1268);
  assert.equal(result.chainTip, 1270);
  assert.equal(result.highestTxId, 1270);
  assert.equal(result.txsScanned, 2);
  assert.ok(result.observations.some((observation) => observation.locator === locatorOf("c")),
    "the artifact named by the newest transaction is read");
});

test("a busy chain holds back transactions that are neither deep nor old", async () => {
  const result = await scanAt([
    transfer(1270, NOW - 10 * SECOND),
    transfer(1269, NOW - 20 * SECOND),
    transfer(1268, NOW - 30 * SECOND),
  ], 1267);
  assert.equal(result.highestTxId, 1268);
  assert.equal(result.txsScanned, 1);
});

test("a recent transaction is indexed once it is deep enough", async () => {
  const result = await scanAt([
    transfer(1272, NOW - 1 * SECOND),
    transfer(1271, NOW - 2 * SECOND),
    transfer(1270, NOW - 3 * SECOND),
  ], 1269);
  assert.equal(result.highestTxId, 1270);
  assert.equal(result.txsScanned, 1);
});

test("a transaction with no valid timestamp is held back by depth alone", async () => {
  for (const timestamp of [undefined, null, 0, -5, 1.5, "soon", "", Number.MAX_SAFE_INTEGER + 1, { at: 1 }]) {
    const result = await scanAt([
      transfer(1270, timestamp),
      transfer(1269, timestamp),
      transfer(1268, timestamp),
    ], 1267);
    assert.equal(result.highestTxId, 1268, `timestamp ${JSON.stringify(timestamp)}`);
    assert.equal(result.txsScanned, 1, `timestamp ${JSON.stringify(timestamp)}`);
  }
});

test("a decimal string timestamp counts like a number", async () => {
  const result = await scanAt([
    transfer(1270, String(NOW - HOUR)),
    transfer(1269, String(NOW - HOUR)),
    transfer(1268, String(NOW - HOUR)),
  ], 1267);
  assert.equal(result.highestTxId, 1270);
  assert.equal(result.txsScanned, 3);
});

test("an old transaction above a recent one does not move the cursor past the recent one", async () => {
  const result = await scanAt([
    transfer(1270, NOW - 7 * HOUR),
    transfer(1269, NOW - 10 * SECOND),
    transfer(1268, NOW - 10 * SECOND),
  ], 1266);
  // 1268 is deep enough; 1269 is neither deep nor old, so 1270 waits behind it.
  assert.equal(result.highestTxId, 1268);
  assert.equal(result.txsScanned, 1);
});

test("a transaction is final at exactly the age limit and not a millisecond before", async () => {
  const atLimit = await scanAt([transfer(1270, NOW - 300 * SECOND), transfer(1269, NOW - 400 * SECOND)], 1268);
  assert.equal(atLimit.highestTxId, 1270);
  const justYounger = await scanAt([transfer(1270, NOW - 300 * SECOND + 1), transfer(1269, NOW - 400 * SECOND)], 1268);
  assert.equal(justYounger.highestTxId, 1269);
});

test("a timestamp in the future never makes a transaction final", async () => {
  const result = await scanAt([transfer(1270, NOW + HOUR), transfer(1269, NOW + HOUR)], 1268);
  assert.equal(result.highestTxId, 1268);
});

test("a depth larger than the window read from the node is decided by depth alone", () => {
  const newest = Array.from({ length: 100 }, (_, index) => ({ id: 1000 - index, timestamp: NOW - HOUR }));
  const rule = { depth: 150, seconds: 300, now: NOW };
  assert.equal(settledTip(newest, 1000, rule), 850);
  assert.equal(settledTip(newest, 1000, { ...rule, depth: 99 }), 1000);
  assert.equal(settledTip([], 1000, rule), 850);
});

test("DACS_SCAN_FINALITY_SECONDS sets the age limit and falls back to 300 when unset or invalid", async () => {
  const twoMinutesOld = [transfer(1270, NOW - 120 * SECOND), transfer(1269, NOW - 120 * SECOND)];
  assert.equal((await scanAt(twoMinutesOld, 1268, { seconds: "60" })).highestTxId, 1270);
  assert.equal((await scanAt(twoMinutesOld, 1268, { seconds: "600" })).highestTxId, 1268);
  for (const seconds of [undefined, "", "0", "-1", "1.5", "soon"]) {
    assert.equal((await scanAt(twoMinutesOld, 1268, { seconds })).highestTxId, 1268, `seconds ${seconds}`);
  }
  const tenMinutesOld = [transfer(1270, NOW - 600 * SECOND), transfer(1269, NOW - 600 * SECOND)];
  for (const seconds of [undefined, "", "0", "-1", "1.5", "soon"]) {
    assert.equal((await scanAt(tenMinutesOld, 1268, { seconds })).highestTxId, 1270, `seconds ${seconds}`);
  }
});
