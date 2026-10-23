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
