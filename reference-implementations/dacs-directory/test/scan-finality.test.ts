import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { observeTip, readTipObservation, settledFromTip, settledTip, tipUnchangedMs } from "../src/catalog/scanFinality.js";

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

let passes = 0;
const directories: string[] = [];
process.on("exit", () => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });

/** A machine is a data directory. Each pass on it is a new process: fresh scanner and store modules, store reopened. */
const newMachine = () => {
  const directory = mkdtempSync(join(tmpdir(), "dacs-finality-"));
  directories.push(directory);
  return directory;
};

/**
 * One indexing pass as the shipped indexer runs it: load the scan state from a freshly opened
 * store, scan with its stored first sighting at local time `now`, save the cursor and the
 * sighting. The cursor is set to `sinceTxId` first so a case can start from any position.
 * `stored` replaces the stored sighting before the pass, to plant a corrupt or future record.
 */
async function passAt(
  machine: string,
  transactions: unknown[],
  sinceTxId: number,
  now: number,
  env: { depth?: string; seconds?: string; stored?: unknown } = {},
) {
  const originalFetch = globalThis.fetch;
  const saved = {
    depth: process.env.DACS_SCAN_FINALITY_DEPTH, seconds: process.env.DACS_SCAN_FINALITY_SECONDS,
    data: process.env.DACS_DIRECTORY_DATA,
  };
  process.env.DACS_DIRECTORY_DATA = machine;
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
    const pass = ++passes;
    const store = await import(`../src/catalog/store.js?pass=${pass}`) as typeof import("../src/catalog/store.js");
    const { scanChain } = await import(`../src/catalog/scan.js?pass=${pass}`) as typeof import("../src/catalog/scan.js");
    const state = store.loadScanState();
    if ("stored" in env) state.tipObservation = env.stored as typeof state.tipObservation;
    const scan = await scanChain(null, { maxTxs: 100, sinceTxId, tipObservation: state.tipObservation, now });
    state.lastSeenTxId = sinceTxId;
    if (scan.tipObservation) state.tipObservation = scan.tipObservation;
    store.saveScanState(state);
    return scan;
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [
      ["DACS_SCAN_FINALITY_DEPTH", saved.depth], ["DACS_SCAN_FINALITY_SECONDS", saved.seconds],
      ["DACS_DIRECTORY_DATA", saved.data],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** The sighting a pass left in the store, read through a store opened afresh. */
async function storedSighting(machine: string) {
  const saved = process.env.DACS_DIRECTORY_DATA;
  process.env.DACS_DIRECTORY_DATA = machine;
  try {
    const store = await import(`../src/catalog/store.js?pass=${++passes}`) as typeof import("../src/catalog/store.js");
    return store.loadScanState().tipObservation;
  } finally {
    if (saved === undefined) delete process.env.DACS_DIRECTORY_DATA;
    else process.env.DACS_DIRECTORY_DATA = saved;
  }
}

test("a quiet chain indexes its newest transactions once the same tip has been observed for the limit, across passes", async () => {
  const machine = newMachine();
  const chain = [transfer(1270, undefined, locatorOf("c")), transfer(1269), transfer(1268)];
  const first = await passAt(machine, chain, 1267, T0);
  assert.equal(first.highestTxId, 1268, "a tip seen for the first time waits for depth");
  assert.deepEqual(await storedSighting(machine), { id: 1270, since: T0 }, "the first sighting is stored");
  const early = await passAt(machine, chain, 1268, T0 + 299 * SECOND);
  assert.equal(early.highestTxId, 1268, "one second short of the limit still waits");
  assert.deepEqual(await storedSighting(machine), { id: 1270, since: T0 }, "a later sighting of the same tip leaves the time alone");
  const settled = await passAt(machine, chain, 1268, T0 + 300 * SECOND);
  assert.equal(settled.chainTip, 1270);
  assert.equal(settled.highestTxId, 1270);
  assert.equal(settled.txsScanned, 2);
  assert.ok(settled.observations.some((observation) => observation.locator === locatorOf("c")),
    "the artifact named by the newest transaction is read");
});

test("a quiet chain still waits when every pass is the first to see the tip", async () => {
  const chain = [transfer(1270), transfer(1269), transfer(1268)];
  for (const [index, delay] of [0, 300 * SECOND, 900 * SECOND, HOUR].entries()) {
    const result = await passAt(newMachine(), chain, 1268, T0 + delay);
    assert.equal(result.highestTxId, 1268, `a machine with no stored sighting, pass ${index}`);
  }
});

test("a stale-signed transaction on a busy chain waits for depth while the tip keeps changing", async () => {
  const machine = newMachine();
  const signedHoursAgo = (tip: number) => chainTo(tip, 3, 7 * HOUR);
  for (const [step, tip] of [1270, 1271, 1272, 1273].entries()) {
    const result = await passAt(machine, signedHoursAgo(tip), tip - 3, T0 + step * 200 * SECOND);
    assert.equal(result.highestTxId, tip - 2, `tip ${tip}`);
    assert.equal(result.txsScanned, 1, `tip ${tip}`);
  }
});

test("transaction timestamps do not change what is final", async () => {
  for (const timestamp of [undefined, null, 0, -5, "soon", T0 - 7 * HOUR, T0 + HOUR, { at: 1 }]) {
    const machine = newMachine();
    const chain = [transfer(1270, timestamp), transfer(1269, timestamp), transfer(1268, timestamp)];
    const first = await passAt(machine, chain, 1267, T0);
    assert.equal(first.highestTxId, 1268, `first pass, timestamp ${JSON.stringify(timestamp)}`);
    const later = await passAt(machine, chain, 1268, T0 + 300 * SECOND);
    assert.equal(later.highestTxId, 1270, `later pass, timestamp ${JSON.stringify(timestamp)}`);
  }
});

test("a change of the tip restarts the clock in the store", async () => {
  const machine = newMachine();
  const at1270 = chainTo(1270, 3, 7 * HOUR);
  const at1271 = chainTo(1271, 3, 7 * HOUR);
  assert.equal((await passAt(machine, at1270, 1267, T0)).highestTxId, 1268);
  assert.equal((await passAt(machine, at1270, 1268, T0 + 250 * SECOND)).highestTxId, 1268);
  const changed = await passAt(machine, at1271, 1268, T0 + 280 * SECOND);
  assert.equal(changed.highestTxId, 1269, "the new tip starts over although the old one was nearly at the limit");
  assert.deepEqual(await storedSighting(machine), { id: 1271, since: T0 + 280 * SECOND });
  assert.equal((await passAt(machine, at1271, 1269, T0 + 579 * SECOND)).highestTxId, 1269);
  assert.equal((await passAt(machine, at1271, 1269, T0 + 580 * SECOND)).highestTxId, 1271);
});

test("a stored first sighting that is in the future or corrupt waits as if the tip was just seen", async () => {
  const chain = [transfer(1270), transfer(1269), transfer(1268)];
  const cases: Array<[string, unknown]> = [
    ["a time in the future", { id: 1270, since: T0 + HOUR + 1 }],
    ["a time far in the future", { id: 1270, since: Number.MAX_SAFE_INTEGER }],
    ["a text time", { id: 1270, since: "0" }],
    ["a fractional time", { id: 1270, since: 0.5 }],
    ["a negative time", { id: 1270, since: -1 }],
    ["a fractional id", { id: 1270.5, since: 0 }],
    ["no id", { since: 0 }],
    ["a text record", "1270"],
    ["a number record", 1270],
  ];
  for (const [label, stored] of cases) {
    const machine = newMachine();
    const result = await passAt(machine, chain, 1268, T0 + HOUR, { stored });
    assert.equal(result.highestTxId, 1268, label);
    assert.deepEqual(await storedSighting(machine), { id: 1270, since: T0 + HOUR }, `${label}: restarted at now`);
    const later = await passAt(machine, chain, 1268, T0 + HOUR + 300 * SECOND);
    assert.equal(later.highestTxId, 1270, `${label}: settles one limit after the restart`);
  }
});

test("a busy chain holds back transactions that are neither deep nor observed long enough", async () => {
  const result = await passAt(newMachine(), [transfer(1270), transfer(1269), transfer(1268)], 1267, T0);
  assert.equal(result.highestTxId, 1268);
  assert.equal(result.txsScanned, 1);
});

test("a missing id among the newest transactions is not final even after the limit", async () => {
  const machine = newMachine();
  const chain = [transfer(1271), transfer(1269), transfer(1268)];
  await passAt(machine, chain, 1267, T0, { depth: "3" });
  const result = await passAt(machine, chain, 1267, T0 + HOUR, { depth: "3" });
  assert.equal(result.highestTxId, 1269);
});

test("the first transactions of a chain settle by time like the rest", async () => {
  for (const tip of [1, 2]) {
    const machine = newMachine();
    const chain = Array.from({ length: tip }, (_, index) => transfer(tip - index));
    const first = await passAt(machine, chain, 0, T0);
    assert.equal(first.highestTxId, 0, `tip ${tip} waits for depth first`);
    const early = await passAt(machine, chain, 0, T0 + 299 * SECOND);
    assert.equal(early.highestTxId, 0, `tip ${tip} one second short of the limit`);
    const settled = await passAt(machine, chain, 0, T0 + 300 * SECOND);
    assert.equal(settled.highestTxId, tip, `tip ${tip} after the limit`);
  }
});

test("DACS_SCAN_FINALITY_SECONDS sets the observation limit and falls back to 300 when unset or invalid", async () => {
  const chain = [transfer(1270), transfer(1269), transfer(1268)];
  const highestAfter = async (waitSeconds: number, seconds: string | undefined) => {
    const machine = newMachine();
    await passAt(machine, chain, 1267, T0, { seconds });
    return (await passAt(machine, chain, 1268, T0 + waitSeconds * SECOND, { seconds })).highestTxId;
  };
  assert.equal(await highestAfter(60, "60"), 1270);
  assert.equal(await highestAfter(120, "600"), 1268);
  for (const seconds of [undefined, "", "0", "-1", "1.5", "soon"]) {
    assert.equal(await highestAfter(120, seconds), 1268, `seconds ${seconds}`);
    assert.equal(await highestAfter(600, seconds), 1270, `seconds ${seconds}`);
  }
});

test("observeTip keeps the first sighting of the same id and restarts on a new id, a bad record or a backwards clock", () => {
  const first = observeTip(undefined, 10, 1_000);
  assert.deepEqual(first, { observation: { id: 10, since: 1_000 }, unchangedMs: 0 });
  const again = observeTip(first.observation, 10, 4_000);
  assert.deepEqual(again, { observation: { id: 10, since: 1_000 }, unchangedMs: 3_000 });
  assert.deepEqual(observeTip(again.observation, 11, 5_000), { observation: { id: 11, since: 5_000 }, unchangedMs: 0 });
  assert.deepEqual(observeTip({ id: 11, since: 5_000 }, 11, 500), { observation: { id: 11, since: 500 }, unchangedMs: 0 },
    "a stored time after now restarts the count");
  assert.deepEqual(observeTip({ id: 11, since: "x" }, 11, 9_000), { observation: { id: 11, since: 9_000 }, unchangedMs: 0 });
});

test("tipUnchangedMs reads the stored sighting without writing and fails closed", () => {
  assert.equal(tipUnchangedMs({ id: 10, since: 1_000 }, 10, 4_000), 3_000);
  assert.equal(tipUnchangedMs({ id: 10, since: 1_000 }, 11, 4_000), 0);
  assert.equal(tipUnchangedMs({ id: 10, since: 5_000 }, 10, 4_000), 0);
  assert.equal(tipUnchangedMs(undefined, 10, 4_000), 0);
  assert.equal(tipUnchangedMs({ id: 10, since: Number.NaN }, 10, 4_000), 0);
  assert.equal(readTipObservation({ id: 10, since: 0, extra: true }) !== null, true);
  assert.equal(readTipObservation({ id: -1, since: 0 }), null);
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

test("the lowest ids settle by time: id 0 is the clamped boundary, not a required row", () => {
  const stable = 300_000;
  assert.equal(settledTip([{ id: 1 }], 1, rule, 0), 0);
  assert.equal(settledTip([{ id: 1 }], 1, rule, stable), 1);
  assert.equal(settledTip([{ id: 2 }, { id: 1 }], 2, rule, 0), 0);
  assert.equal(settledTip([{ id: 2 }, { id: 1 }], 2, rule, stable), 2);
  assert.equal(settledTip([{ id: 2 }, { id: 1 }, { id: 0 }], 2, rule, stable), 2);
  assert.equal(settledTip([{ id: 2 }], 2, rule, stable), 0, "id 1 is unreadable");
  assert.equal(settledTip([{ id: 3 }, { id: 2 }, { id: 1 }], 3, rule, stable), 3);
  assert.equal(settledTip([{ id: 3 }, { id: 2 }], 3, rule, stable), 1, "the boundary id 1 is unreadable");
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
