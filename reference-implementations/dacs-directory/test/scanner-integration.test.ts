import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Isolate the SQLite store BEFORE anything imports it: scan.ts transitively
// opens store.ts at module load, so the data dir must be set first.
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-scanner-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
const { parseAnchorTimestamp, scanChain } = await import("../src/catalog/scan.js");
const store = await import("../src/catalog/store.js");

test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));

const ADDR = (c: string) => `stor-${c.repeat(40)}`;
const A = ADDR("a"); // readable listing, createdAt anchor
const B = ADDR("b"); // inside the finality holdback
const C = ADDR("c"); // readable, numeric createdAt
const Z = ADDR("d"); // referenced by a failed tx, but no storage record exists

// Storage reads keyed by locator. createdAt is the write-apply metadata the
// scanner now uses; Z is intentionally absent (unreadable).
const STORAGE: Record<string, unknown> = {
  [A]: { success: true, owner: "0xowner-a", programName: "dacs1:listing:a", createdAt: "2026-07-11T16:30:42.131Z", data: { dacsVersion: "1", listingId: "a", listingVersion: 1 } },
  [C]: { success: true, owner: "0xowner-c", programName: "other:c", createdAt: 1700000000050, data: {} },
};

function txFor(id: number): Record<string, unknown> {
  if (id === 100) return { id, status: "success", data: { ref: A } };
  if (id === 119) return { id, status: "success", data: { ref: B } }; // within finality holdback
  if (id === 50) return { id, status: "success", data: { ref: C } };
  if (id === 40) return { id, status: "failed", data: { ref: Z } };    // failed tx referencing Z
  return { id };
}

function installFetch(opts: { maxId: number; failOnStart?: number | "latest" }, calls: Array<number | "latest">) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const storageMatch = url.match(/\/storage-program\/(stor-[0-9a-f]{40})$/);
    if (storageMatch) {
      const record = STORAGE[storageMatch[1]];
      return record
        ? new Response(JSON.stringify(record), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ success: false }), { status: 404 });
    }
    const body = JSON.parse(init?.body ?? "{}") as { params: Array<{ message: string; data: { start: number | "latest"; limit: number } }> };
    const { message, data } = body.params[0];
    assert.equal(message, "getTransactions");
    calls.push(data.start);
    if (opts.failOnStart !== undefined && data.start === opts.failOnStart) throw new TypeError("simulated RPC transport failure");
    const top = data.start === "latest" ? opts.maxId : Math.min(data.start as number, opts.maxId);
    const page: Array<Record<string, unknown>> = [];
    for (let id = top; id > 0 && page.length < data.limit; id--) page.push(txFor(id));
    return new Response(JSON.stringify({ result: 200, response: page }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

test("parseAnchorTimestamp accepts ISO strings, numbers, decimal strings; rejects junk", () => {
  assert.equal(parseAnchorTimestamp("2026-07-11T16:30:42.131Z"), Date.parse("2026-07-11T16:30:42.131Z"));
  assert.equal(parseAnchorTimestamp(1700000000000), 1700000000000);
  assert.equal(parseAnchorTimestamp("1700000000000"), 1700000000000);
  assert.equal(parseAnchorTimestamp("not-a-date"), undefined);
  assert.equal(parseAnchorTimestamp("-5"), undefined);
  assert.equal(parseAnchorTimestamp(-1), undefined);
  assert.equal(parseAnchorTimestamp(null), undefined);
});

test("scanChain paginates, holds the finalized tip, and anchors from storage createdAt", async () => {
  const calls: Array<number | "latest"> = [];
  const restore = installFetch({ maxId: 120 }, calls);
  try {
    const scan = await scanChain(null, { sinceTxId: 0 });
    assert.equal(scan.complete, true);
    assert.equal(scan.chainTip, 120);
    assert.deepEqual(calls, ["latest", 20]); // two pages

    const byLocator = new Map(scan.observations.map((o) => [o.locator, o]));
    assert.ok(byLocator.has(A) && byLocator.has(C), "finalized readable records are observed");
    assert.ok(!byLocator.has(B), "a tx inside the finality holdback is not scanned");

    // Anchor time is the storage record's createdAt, ISO or numeric.
    assert.equal(byLocator.get(A)?.anchorTime, Date.parse("2026-07-11T16:30:42.131Z"));
    assert.equal(byLocator.get(C)?.anchorTime, 1700000000050);
  } finally {
    restore();
  }
});

test("a failed/unrelated transaction referencing a locator cannot anchor it", async () => {
  const calls: Array<number | "latest"> = [];
  const restore = installFetch({ maxId: 120 }, calls);
  try {
    const scan = await scanChain(null, { sinceTxId: 0 });
    const byLocator = new Map(scan.observations.map((o) => [o.locator, o]));
    // Z is named only by a failed tx and has no storage record → never observed,
    // never anchored. The scanner cannot be tricked into backdating from a tx.
    assert.ok(!byLocator.has(Z), "an unreadable locator from a failed tx is not observed");
  } finally {
    restore();
  }
});

test("scanChain surfaces a partial RPC failure instead of silently completing", async () => {
  const calls: Array<number | "latest"> = [];
  const restore = installFetch({ maxId: 120, failOnStart: 20 }, calls);
  try {
    const scan = await scanChain(null, { sinceTxId: 0 });
    assert.equal(scan.complete, false);
    assert.match(scan.scanError ?? "", /transport failure/);
    assert.equal(scan.chainTip, 120);
  } finally {
    restore();
  }
});

test("store keeps the earliest anchor time and backfills NULL rows", () => {
  const locator = A;
  store.recordArtifact({ locator, kind: "listing", profile: "dacs-v0.1", observedAt: 1, anchorTime: 1700000000200 });
  assert.equal(store.artifactAnchorTime(locator), 1700000000200);
  // A later re-observation must never raise the anchor time.
  store.recordArtifact({ locator, kind: "listing", profile: "dacs-v0.1", observedAt: 2, anchorTime: 1700000000500 });
  assert.equal(store.artifactAnchorTime(locator), 1700000000200);

  // Backfill: an artifact observed with no anchor time is selectable and can be
  // set once, then keeps the earliest on repeat.
  const pending = ADDR("e");
  store.recordArtifact({ locator: pending, kind: "listing", profile: "dacs-v0.1", observedAt: 3 });
  assert.ok(store.loadUnanchoredArtifacts(50).includes(pending));
  store.backfillAnchorTime(pending, 1700000000900);
  assert.equal(store.artifactAnchorTime(pending), 1700000000900);
  assert.ok(!store.loadUnanchoredArtifacts(50).includes(pending), "a backfilled row leaves the pending set");
  store.backfillAnchorTime(pending, 1700000000700);
  assert.equal(store.artifactAnchorTime(pending), 1700000000700, "backfill also keeps the earliest");
});
