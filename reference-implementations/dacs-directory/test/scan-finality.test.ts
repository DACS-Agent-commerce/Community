import assert from "node:assert/strict";
import test from "node:test";

import { scanChain } from "../src/catalog/scan.js";
import { observeTip, resetTipObservation, settledFromTip, settledTip } from "../src/catalog/scanFinality.js";

const T0 = 1_800_000_000_000;
const SECOND = 1_000;
const HOUR = 3_600 * SECOND;
const owner = `0x${"1".repeat(64)}`;
const locatorOf = (digit: string) => `stor-${digit.repeat(40)}`;
const rule = { depth: 2, seconds: 300 };

/** A transfer that carries a storage locator in its memo, like the scanner's other fixtures. */
const transfer = (id: number, timestamp: unknown = undefined, locator = locatorOf("a")) => ({
  id, status: "confirmed", type: "transfer", hash: String(id % 10).repeat(64), blockNumber: id, to: "0x1",
  timestamp, content: JSON.stringify({ memo: locator }),
});

/** The newest `count` transactions up to `tip`, each signed `signedAgo` before T0. */
const chainTo = (tip: number, count: number, signedAgo: number, locatorOfTip = locatorOf("a")) =>
  Array.from({ length: count }, (_, index) => transfer(tip - index, T0 - signedAgo, index === 0 ? locatorOfTip : locatorOf("a")));

/** One scan against a stubbed node whose whole history fits in the first page, at local time `now`. */
async function scanAt(
  transactions: unknown[],
  sinceTxId: number,
  now: number,
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
    return await scanChain(null, { maxTxs: 100, sinceTxId, now });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [["DACS_SCAN_FINALITY_DEPTH", saved.depth], ["DACS_SCAN_FINALITY_SECONDS", saved.seconds]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("a quiet chain indexes its newest transactions once the same tip has been observed for the limit", async () => {
  resetTipObservation();
  const chain = [transfer(1270, undefined, locatorOf("c")), transfer(1269), transfer(1268)];
  const first = await scanAt(chain, 1267, T0);
  assert.equal(first.highestTxId, 1268, "a tip seen for the first time waits for depth");
  const early = await scanAt(chain, 1268, T0 + 299 * SECOND);
  assert.equal(early.highestTxId, 1268, "one second short of the limit still waits");
  const settled = await scanAt(chain, 1268, T0 + 300 * SECOND);
  assert.equal(settled.chainTip, 1270);
  assert.equal(settled.highestTxId, 1270);
  assert.equal(settled.txsScanned, 2);
  assert.ok(settled.observations.some((observation) => observation.locator === locatorOf("c")),
    "the artifact named by the newest transaction is read");
});

test("a stale-signed transaction on a busy chain waits for depth while the tip keeps changing", async () => {
  resetTipObservation();
  const signedHoursAgo = (tip: number) => chainTo(tip, 3, 7 * HOUR);
  for (const [step, tip] of [1270, 1271, 1272, 1273].entries()) {
    const result = await scanAt(signedHoursAgo(tip), tip - 3, T0 + step * 200 * SECOND);
    assert.equal(result.highestTxId, tip - 2, `tip ${tip}`);
    assert.equal(result.txsScanned, 1, `tip ${tip}`);
  }
});

test("transaction timestamps do not change what is final", async () => {
  for (const timestamp of [undefined, null, 0, -5, "soon", T0 - 7 * HOUR, T0 + HOUR, { at: 1 }]) {
    resetTipObservation();
    const chain = [transfer(1270, timestamp), transfer(1269, timestamp), transfer(1268, timestamp)];
    const first = await scanAt(chain, 1267, T0);
    assert.equal(first.highestTxId, 1268, `first pass, timestamp ${JSON.stringify(timestamp)}`);
    const later = await scanAt(chain, 1268, T0 + 300 * SECOND);
    assert.equal(later.highestTxId, 1270, `later pass, timestamp ${JSON.stringify(timestamp)}`);
  }
});

test("a change of the tip restarts the clock", async () => {
  resetTipObservation();
  const at1270 = chainTo(1270, 3, 7 * HOUR);
  const at1271 = chainTo(1271, 3, 7 * HOUR);
  assert.equal((await scanAt(at1270, 1267, T0)).highestTxId, 1268);
  assert.equal((await scanAt(at1270, 1268, T0 + 250 * SECOND)).highestTxId, 1268);
  const changed = await scanAt(at1271, 1268, T0 + 280 * SECOND);
  assert.equal(changed.highestTxId, 1269, "the new tip starts over although the old one was nearly at the limit");
  assert.equal((await scanAt(at1271, 1269, T0 + 579 * SECOND)).highestTxId, 1269);
  assert.equal((await scanAt(at1271, 1269, T0 + 580 * SECOND)).highestTxId, 1271);
});

test("a busy chain holds back transactions that are neither deep nor observed long enough", async () => {
  resetTipObservation();
  const result = await scanAt([transfer(1270), transfer(1269), transfer(1268)], 1267, T0);
  assert.equal(result.highestTxId, 1268);
  assert.equal(result.txsScanned, 1);
});

test("a missing id among the newest transactions is not final even after the limit", async () => {
  resetTipObservation();
  const chain = [transfer(1271), transfer(1269), transfer(1268)];
  await scanAt(chain, 1267, T0, { depth: "3" });
  const result = await scanAt(chain, 1267, T0 + HOUR, { depth: "3" });
  assert.equal(result.highestTxId, 1269);
});

test("DACS_SCAN_FINALITY_SECONDS sets the observation limit and falls back to 300 when unset or invalid", async () => {
  const chain = [transfer(1270), transfer(1269), transfer(1268)];
  const highestAfter = async (waitSeconds: number, seconds: string | undefined) => {
    resetTipObservation();
    await scanAt(chain, 1267, T0, { seconds });
    return (await scanAt(chain, 1268, T0 + waitSeconds * SECOND, { seconds })).highestTxId;
  };
  assert.equal(await highestAfter(60, "60"), 1270);
  assert.equal(await highestAfter(120, "600"), 1268);
  for (const seconds of [undefined, "", "0", "-1", "1.5", "soon"]) {
    assert.equal(await highestAfter(120, seconds), 1268, `seconds ${seconds}`);
    assert.equal(await highestAfter(600, seconds), 1270, `seconds ${seconds}`);
  }
});

test("observeTip counts from the first sighting of the same id and restarts on a new id or a backwards clock", () => {
  resetTipObservation();
  assert.equal(observeTip(10, 1_000), 0);
  assert.equal(observeTip(10, 4_000), 3_000);
  assert.equal(observeTip(11, 5_000), 0);
  assert.equal(observeTip(11, 6_000), 1_000);
  assert.equal(observeTip(11, 500), 0, "a clock that moved backwards restarts the count");
  assert.equal(observeTip(11, 1_500), 1_000);
  resetTipObservation();
  assert.equal(observeTip(11, 9_000), 0);
});

test("settledFromTip uses the tip only after the limit and never goes below zero", () => {
  assert.equal(settledFromTip(1270, rule, 299_999), 1268);
  assert.equal(settledFromTip(1270, rule, 300_000), 1270);
  assert.equal(settledFromTip(1, rule, 0), 0);
  assert.equal(settledFromTip(-5, rule, 0), 0);
  assert.equal(settledFromTip(-5, rule, 300_000), 0);
});

test("settledTip needs every id from the depth boundary to the tip once the tip is final", () => {
  const stable = 300_000;
  assert.equal(settledTip([{ id: 1270 }, { id: 1269 }, { id: 1268 }], 1270, rule, stable), 1270);
  assert.equal(settledTip([{ id: 1270 }, { id: 1269 }, { id: 1268 }], 1270, rule, 0), 1268);
  assert.equal(settledTip([{ id: 1270 }, { id: 1269 }], 1270, rule, stable), 1268, "the id at the boundary is unreadable");
  assert.equal(settledTip([{ id: 1271 }, { id: 1269 }, { id: 1268 }], 1271, { depth: 3, seconds: 300 }, stable), 1269);
  assert.equal(settledTip([{ id: 1271 }, { id: 1270 }, { id: 1268 }], 1271, rule, stable), 1269);
  assert.equal(settledTip([{ id: 1270 }, { id: 1269 }, { id: "1268" }], 1270, rule, stable), 1268);
});

test("a negative newest id never gives a negative settled tip", () => {
  assert.equal(settledTip([{ id: -5 }], -5, rule, 300_000), 0);
  assert.equal(settledTip([], -5, rule, 0), 0);
  assert.equal(settledTip([{ id: -5 }], -5, { ...rule, depth: 0 }, 300_000), 0);
});

test("a null or non-object row does not make the rule throw", () => {
  const rows = [{ id: 1270 }, null, "x", 7] as unknown as Array<{ id?: unknown }>;
  assert.equal(settledTip(rows, 1270, rule, 300_000), 1268);
});

test("a depth larger than the rows that can be read is decided by depth alone", () => {
  const newest = Array.from({ length: 100 }, (_, index) => ({ id: 1000 - index }));
  const deep = { depth: 150, seconds: 300 };
  assert.equal(settledTip(newest, 1000, deep, 300_000), 850);
  assert.equal(settledTip(newest, 1000, { ...deep, depth: 99 }, 300_000), 1000);
  assert.equal(settledTip([], 1000, deep, 300_000), 850);
});
