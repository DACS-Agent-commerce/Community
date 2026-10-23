import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET } from "../app/api/dacs/status/route.js";
import { pinnedChainIdentity } from "../src/catalog/nodeDeployment.js";
import { recordListingRejection } from "../src/catalog/store.js";
import { createStatusNodeObservationCache, statusNodeObservationCache, STATUS_NODE_OBSERVATION_TTL_MS } from "../src/catalog/statusNodeObservation.js";

test("node status shares concurrent probes, expires at 30 seconds, and refreshes on configuration changes", async () => {
  let now = 1_000, calls = 0, key = "chain-a", blocked = true;
  let release = () => {};
  const value = { nodeDeployment: { ok: false as const, unavailable: true, reason: "unavailable" }, chainLatestTx: null };
  const cache = createStatusNodeObservationCache(async () => {
    calls++;
    if (blocked) await new Promise<void>((resolve) => { release = resolve; });
    return value;
  }, () => now, () => key);
  const first = cache.read(), second = cache.read();
  await Promise.resolve();
  assert.equal(calls, 1);
  release(); blocked = false;
  assert.deepEqual(await Promise.all([first, second]), [value, value]);
  now += STATUS_NODE_OBSERVATION_TTL_MS - 1;
  assert.deepEqual(await cache.read(), value, "unavailable results are cached too");
  assert.equal(calls, 1);
  now++;
  await cache.read();
  assert.equal(calls, 2, "refresh at the exact TTL boundary");
  key = "chain-b";
  await cache.read();
  assert.equal(calls, 3, "configuration changes cannot reuse another chain's observation");
  now--;
  await cache.read();
  assert.equal(calls, 4, "a backwards clock cannot extend a cached observation");
});

test("unexpected probe errors release the shared request for a later retry", async () => {
  let calls = 0;
  const cache = createStatusNodeObservationCache(async () => { calls++; throw new Error("probe failed"); });
  await assert.rejects(cache.read(), /probe failed/);
  await assert.rejects(cache.read(), /probe failed/);
  assert.equal(calls, 2);
});

test("default status probe pins the RPC request and refuses malformed tip replies", async (t) => {
  let reply: unknown;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const call = body.params[0];
    if (call.message === "getBlockByNumber") return Response.json({ result: 200, response: { hash: pinnedChainIdentity() } });
    if (call.message === "getNetworkInfo") return Response.json({ result: 200, response: {} });
    calls++;
    assert.equal(String(input), (process.env.DEMOS_RPC ?? "https://demosnode.discus.sh/").replace(/\/$/, "") + "/");
    assert.equal(init?.method, "POST");
    assert.deepEqual(init?.headers, { "content-type": "application/json" });
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal instanceof AbortSignal);
    assert.deepEqual(body, { method: "nodeCall", params: [{ type: "nodeCall", message: "getTransactions",
      sender: null, receiver: null, timestamp: null, data: { start: "latest", limit: 1 }, extra: "" }] });
    return Response.json(reply);
  });
  const cache = createStatusNodeObservationCache();
  const replies: Array<[unknown, number | null]> = [
    [{ result: 200, response: [{ id: 0 }] }, 0],
    [{ result: 200, response: [{ id: 12 }] }, 12],
    [{ result: 500, response: [{ id: 12 }] }, null],
    [{ result: 200, response: [{ id: 12 }, { id: 13 }] }, null],
    [{ result: 200, response: { id: 12 } }, null],
    ...[-1, 0.5, "12", undefined, Number.MAX_SAFE_INTEGER + 1].map(id =>
      [{ result: 200, response: [{ id }] }, null] as [unknown, null]),
  ];
  for (const [body, expected] of replies) {
    reply = body; cache.invalidate();
    const result = await cache.read();
    assert.equal(result.nodeDeployment.ok, true);
    assert.equal(result.chainLatestTx, expected, JSON.stringify(body));
  }
  assert.equal(calls, replies.length);
});

test("default status configuration observes chain identity and build pin changes", async () => {
  const saved = [process.env.DEMOS_CHAIN_IDENTITY, process.env.DEMOS_NODE_BUILDS];
  let calls = 0;
  const cache = createStatusNodeObservationCache(async () => ({
    nodeDeployment: { ok: false, unavailable: true, reason: "offline" }, chainLatestTx: ++calls,
  }));
  try {
    await cache.read(); await cache.read();
    assert.equal(calls, 1);
    process.env.DEMOS_CHAIN_IDENTITY = "a".repeat(64);
    await cache.read();
    assert.equal(calls, 2);
    process.env.DEMOS_NODE_BUILDS = "b".repeat(40);
    await cache.read(); await cache.read();
    assert.equal(calls, 3);
  } finally {
    for (const [i, name] of ["DEMOS_CHAIN_IDENTITY", "DEMOS_NODE_BUILDS"].entries()) {
      if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i];
    }
  }
});

test("obsolete probes cannot overwrite a new cache or clear its shared pending request", async () => {
  for (const change of ["invalidate", "configuration"] as const) {
    for (const oldFirst of [true, false]) {
      let key = "a", calls = 0;
      const releases: Array<(value: { nodeDeployment: { ok: false; unavailable: boolean; reason: string }; chainLatestTx: number }) => void> = [];
      const cache = createStatusNodeObservationCache(() => {
        calls++;
        return new Promise(resolve => releases.push(resolve));
      }, () => 1, () => key);
      const value = (id: number) => ({ nodeDeployment: { ok: false as const, unavailable: true, reason: "offline" }, chainLatestTx: id });
      const old = cache.read(); await Promise.resolve();
      if (change === "invalidate") cache.invalidate(); else key = "b";
      const current = cache.read(); await Promise.resolve();
      assert.equal(calls, 2);
      if (oldFirst) {
        releases[0](value(1)); await old;
        const shared = cache.read(); await Promise.resolve();
        assert.equal(calls, 2, "old completion must not clear the current in-flight request");
        releases[1](value(2));
        assert.equal((await shared).chainLatestTx, 2);
      } else {
        releases[1](value(2)); await current;
        releases[0](value(1)); await old;
      }
      assert.equal((await current).chainLatestTx, 2);
      assert.equal((await cache.read()).chainLatestTx, 2, "old completion must not replace cached current data");
      assert.equal(calls, 2);
    }
  }
});

test("a failed default deployment probe has a nonempty non-timeout cause", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  const result = await createStatusNodeObservationCache().read();
  assert.equal(result.nodeDeployment.ok, false);
  assert.ok("reason" in result.nodeDeployment && result.nodeDeployment.reason.length > 0);
  assert.equal(result.chainLatestTx, null);
});

test("concurrent HTTP status calls share node reads while persisted diagnostics stay current", async (t) => {
  statusNodeObservationCache.invalidate();
  t.after(() => statusNodeObservationCache.invalidate());
  let now = 1_000, calls = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls++;
    const call = JSON.parse(String(init?.body)).params[0];
    if (call.message === "getBlockByNumber") return call.data.blockNumber === 0
      ? Response.json({ result: 400, response: "error" })
      : Response.json({ result: 200, response: { number: 1, status: "confirmed", hash: "b".repeat(64), content: { previousHash: pinnedChainIdentity() } } });
    if (call.message === "getNetworkInfo") return Response.json({ result: 200, response: {} });
    return Response.json({ result: 200, response: [{ id: calls }] });
  });
  const request = () => new NextRequest("https://directory.example/api/dacs/status");
  const responses = await Promise.all(Array.from({ length: 8 }, () => GET(request())));
  const bodies = await Promise.all(responses.map((response) => response.json()));
  assert.equal(calls, 4);
  assert.ok(bodies.every((body) => body.nodeDeployment.ok && body.chainLatestTx === 4));
  recordListingRejection(`stor-${"e".repeat(40)}`, `did:demos:agent:${"e".repeat(64)}`, "OWNER_CLAIM_BINDING");
  const updated = await (await GET(request())).json();
  assert.equal(updated.indexer.listingRejectionDiagnostics.total, 1);
  assert.equal(calls, 4, "new diagnostics do not force another node probe");
  now += STATUS_NODE_OBSERVATION_TTL_MS;
  assert.equal((await (await GET(request())).json()).chainLatestTx, 8);
  assert.equal(calls, 8);
});
