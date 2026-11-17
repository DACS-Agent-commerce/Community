import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

import { parseStatusDiagnosticsQuery } from "../src/catalog/statusDiagnostics.js";
import { catalogStatusSchema } from "../src/catalog/contracts.js";
import {
  cursorProgressDiagnostics,
  cursorStallThresholdSeconds,
} from "../src/catalog/statusDiagnostics.js";

const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-dead-letters-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
const store = await import("../src/catalog/store.js");
const statusRoute = await import("../app/api/dacs/status/route.js");

const locator = (digit: string) => `stor-${digit.repeat(40)}`;

test.after(() => {
  rmSync(dataDirectory, { recursive: true, force: true });
});

test("status diagnostics query is bounded and locator-specific", () => {
  assert.deepEqual(parseStatusDiagnosticsQuery(new URLSearchParams()), {
    ok: true, deadLetterLimit: 20,
  });
  assert.deepEqual(parseStatusDiagnosticsQuery(new URLSearchParams({
    deadLetterLimit: "100", locator: locator("a"),
  })), {
    ok: true, deadLetterLimit: 100, deadLetterLocator: locator("a"),
  });
  assert.equal(parseStatusDiagnosticsQuery(new URLSearchParams({ deadLetterLimit: "101" })).ok, false);
  assert.equal(parseStatusDiagnosticsQuery(new URLSearchParams({ deadLetterLimit: "1.5" })).ok, false);
  assert.equal(parseStatusDiagnosticsQuery(new URLSearchParams({ locator: "stor-NOT-AN-ADDRESS" })).ok, false);
});

test("dead-letter diagnostics are safe, bounded, filterable, and recoverable", () => {
  const scanRun = store.beginScanRun(0);
  store.finishScanRun(scanRun, {
    toTx: 0, txs: 0, artifacts: 0, rejected: 0,
    error: "connect ECONNREFUSED https://private-rpc.internal:443/raw-path",
  });
  store.recordArtifactFailure(locator("1"), "unknown", "STORAGE_UNREADABLE", "secret upstream hostname", 1);
  store.recordArtifactFailure(locator("2"), "bundle", "RAW_/private/path", "secret stack trace", 1);
  store.recordArtifactFailure(locator("3"), "unknown", "STORAGE_UNREADABLE", "another raw error", 1);

  const bounded = store.indexerDiagnostics({ deadLetterLimit: 2 });
  assert.equal(bounded.deadLetters, 3);
  assert.equal(bounded.deadLetterDiagnostics.total, 3);
  assert.equal(bounded.deadLetterDiagnostics.returned, 2);
  assert.equal(bounded.deadLetterDiagnostics.hasMore, true);
  assert.equal(bounded.deadLetterDiagnostics.byCode.STORAGE_UNREADABLE, 2);
  assert.equal(bounded.deadLetterDiagnostics.byCode.INDEXER_REJECTED, 1);
  assert.equal(bounded.deadLetterDiagnostics.byKind.unknown, 2);
  assert.equal(bounded.deadLetterDiagnostics.byKind.bundle, 1);
  assert.equal(bounded.lastRun?.status, "failed");
  assert.ok(bounded.lastRun && !("error" in bounded.lastRun));
  assert.doesNotMatch(JSON.stringify(bounded), /secret|private[-/]rpc|private\/path|raw-path|ECONNREFUSED|stack trace/);

  const filtered = store.indexerDiagnostics({ deadLetterLocator: locator("2") });
  assert.equal(filtered.deadLetterDiagnostics.returned, 1);
  assert.equal(filtered.deadLetterDiagnostics.hasMore, false);
  assert.equal(filtered.deadLetterDiagnostics.items[0].locator, locator("2"));
  assert.equal(filtered.deadLetterDiagnostics.items[0].classification, "dacs-artifact");
  assert.equal(filtered.deadLetterDiagnostics.items[0].code, "INDEXER_REJECTED");
  assert.equal(filtered.deadLetterDiagnostics.items[0].retryState, "exhausted");

  const recovered = locator("4");
  store.recordArtifactFailure(recovered, "unknown", "STORAGE_UNREADABLE", "first", 2);
  store.recordArtifactFailure(recovered, "unknown", "STORAGE_UNREADABLE", "second", 2);
  assert.equal(store.indexerDiagnostics({ deadLetterLocator: recovered }).deadLetterDiagnostics.items[0].attempts, 2);

  store.recordArtifact({
    locator: recovered, kind: "listing", profile: "dacs-v0.1", owner: "0xowner", observedAt: Date.now(), data: { ok: true },
  });
  assert.equal(store.indexerDiagnostics({ deadLetterLocator: recovered }).deadLetterDiagnostics.returned, 0);

  // A later failure starts a fresh retry lifecycle instead of inheriting the
  // exhausted count and immediately returning to the dead-letter queue.
  store.recordArtifactFailure(recovered, "listing", "STORAGE_UNREADABLE", "fresh failure", 2);
  assert.equal(store.indexerDiagnostics({ deadLetterLocator: recovered }).deadLetterDiagnostics.returned, 0);
  assert.ok(store.loadRetryableArtifacts(Date.now() + 60_000).includes(recovered));
  store.recordArtifactFailure(recovered, "listing", "STORAGE_UNREADABLE", "fresh failure again", 2);
  const failedAgain = store.indexerDiagnostics({ deadLetterLocator: recovered }).deadLetterDiagnostics.items[0];
  assert.equal(failedAgain.attempts, 2);
  assert.equal(failedAgain.classification, "dacs-artifact");
});

test("storage cause diagnostics are actionable without claiming DACS absence", () => {
  const missing = locator("a");
  const privateLocator = locator("b");
  store.recordArtifactFailure(missing, "unknown", "STORAGE_NOT_FOUND", "raw 404 response", 1);
  store.recordArtifactFailure(privateLocator, "unknown", "STORAGE_NOT_PUBLIC", "raw 403 response", 1);

  const missingDiagnostic = store.indexerDiagnostics({ deadLetterLocator: missing })
    .deadLetterDiagnostics.items[0];
  assert.equal(missingDiagnostic.code, "STORAGE_NOT_FOUND");
  assert.match(missingDiagnostic.message, /operational evidence only/);
  assert.match(missingDiagnostic.message, /not authoritative DACS absence evidence/);
  assert.doesNotMatch(JSON.stringify(missingDiagnostic), /raw 404 response/);

  const privateDiagnostic = store.indexerDiagnostics({ deadLetterLocator: privateLocator })
    .deadLetterDiagnostics.items[0];
  assert.equal(privateDiagnostic.code, "STORAGE_NOT_PUBLIC");
  assert.match(privateDiagnostic.message, /not publicly readable/);
  assert.doesNotMatch(JSON.stringify(privateDiagnostic), /raw 403 response/);
});

test("listing binding rejections are persistent, public-safe, filterable, and recoverable", () => {
  const target = locator("7");
  const claim = `did:demos:agent:${"7".repeat(64)}`;
  store.recordListingRejection(target, claim, "OWNER_CLAIM_BINDING", {
    listingId: "seller-service",
    listingVersion: 3,
  });
  store.recordListingRejection(target, claim, "OWNER_CLAIM_BINDING", {
    listingId: "seller-service",
    listingVersion: 3,
  });

  const diagnostics = store.indexerDiagnostics({ deadLetterLocator: target });
  assert.equal(diagnostics.listingRejectionDiagnostics.scope, "listing-admission");
  assert.equal(diagnostics.listingRejectionDiagnostics.total, 1);
  assert.equal(diagnostics.listingRejectionDiagnostics.returned, 1);
  assert.equal(diagnostics.listingRejectionDiagnostics.byCode.OWNER_CLAIM_BINDING, 1);
  assert.deepEqual(diagnostics.listingRejectionDiagnostics.items[0], {
    locator: target,
    listingId: "seller-service",
    listingVersion: 3,
    publicNotice: false,
    code: "OWNER_CLAIM_BINDING",
    message: "The listing anchor owner does not match the registration claim.",
    guidance: "Correct the registration's storage pointer to an anchor owned by the seller.",
    occurrences: 2,
    firstSeenAt: diagnostics.listingRejectionDiagnostics.items[0].firstSeenAt,
    lastSeenAt: diagnostics.listingRejectionDiagnostics.items[0].lastSeenAt,
  });
  assert.doesNotMatch(JSON.stringify(diagnostics.listingRejectionDiagnostics), new RegExp(claim));

  store.clearListingRejection(target, claim);
  assert.equal(store.indexerDiagnostics({ deadLetterLocator: target }).listingRejectionDiagnostics.returned, 0);
});

test("normative listing admission failures expose stable public-safe diagnostics", () => {
  const target = locator("8");
  const claim = `did:demos:agent:${"8".repeat(64)}`;
  store.recordListingRejection(target, claim, "VERIFICATION_METHOD_INVALID");

  const diagnostics = store.indexerDiagnostics({ deadLetterLocator: target })
    .listingRejectionDiagnostics;
  assert.equal(diagnostics.scope, "listing-admission");
  assert.equal(diagnostics.byCode.VERIFICATION_METHOD_INVALID, 1);
  assert.equal(diagnostics.items[0].code, "VERIFICATION_METHOD_INVALID");
  assert.match(diagnostics.items[0].message, /registered structured variant/);
  assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(claim));
});

test("cursor progress diagnostics distinguish caught-up, stalled, and unknown cursors", () => {
  const now = 1_000_000;
  assert.equal(cursorStallThresholdSeconds("60"), 60);
  assert.equal(cursorStallThresholdSeconds(undefined, "900"), 1_800);
  assert.equal(cursorStallThresholdSeconds(undefined, "60"), 300);
  assert.equal(cursorStallThresholdSeconds(undefined, "600"), 1_200);
  assert.equal(cursorStallThresholdSeconds("0", "600"), 1_200);
  assert.equal(cursorStallThresholdSeconds(undefined, "invalid"), 1_800);
  assert.deepEqual(cursorProgressDiagnostics(
    { lastSeenTxId: 10, cursorAdvancedAt: now - 61_000 },
    12,
    now,
    60,
  ), {
    cursorAdvancedAt: now - 61_000,
    secondsSinceCursorAdvanced: 61,
    cursorStallThresholdSeconds: 60,
    cursorStalled: true,
  });
  assert.equal(cursorProgressDiagnostics(
    { lastSeenTxId: 12, cursorAdvancedAt: now - 61_000 },
    12,
    now,
    60,
  ).cursorStalled, false);
  const finalAt = (secondsAgo: number) => ({ aboveId: 10, atMs: now - secondsAgo * 1_000 });
  const aged = { lastSeenTxId: 10, cursorAdvancedAt: now - 3_600_000 };
  assert.equal(cursorProgressDiagnostics(aged, 12, now, 60, finalAt(59)).cursorStalled, false);
  assert.equal(cursorProgressDiagnostics(aged, 12, now, 60, finalAt(60)).cursorStalled, true);
  assert.equal(cursorProgressDiagnostics(aged, 12, now, 60, finalAt(3_700)).cursorStalled, true, "the cursor moved after");
  assert.equal(cursorProgressDiagnostics({ ...aged, lastSeenTxId: 9 }, 12, now, 60, finalAt(0)).cursorStalled, true,
    "ids at or below the boundary have been final since the cursor moved");
  assert.equal(cursorProgressDiagnostics({ lastSeenTxId: 10 }, 12, now, 60, finalAt(900)).cursorStalled, null);
  assert.equal(cursorProgressDiagnostics({ lastSeenTxId: 10 }, 12, now, 60).cursorStalled, null);
  assert.equal(cursorProgressDiagnostics(
    { lastSeenTxId: 10, cursorAdvancedAt: now },
    null,
    now,
    60,
  ).cursorStalled, null);
});

const STATUS_NOW = 1_800_000_000_000;
const SEVEN_HOURS_MS = 7 * 3_600_000;

/**
 * Status for a scan cursor at `cursor`, advanced seven hours ago, against a node that answers
 * with the newest `limit` of `chain`. The caller fixes the clock. `limits` collects the limits asked for.
 */
async function statusWith(cursor: number, chain: unknown[], limits: unknown[] = [], tipObservation?: unknown) {
  store.saveScanState({
    lastSeenTxId: cursor, cursorAdvancedAt: STATUS_NOW - SEVEN_HOURS_MS, listings: {}, deals: {},
    ...(tipObservation === undefined ? {} : { tipObservation }),
  } as Parameters<typeof store.saveScanState>[0]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const limit = JSON.parse(String(init?.body)).params?.[0]?.data?.limit;
    limits.push(limit);
    return Response.json({ result: 200, response: chain.slice(0, limit) });
  };
  try {
    const response = await statusRoute.GET(new NextRequest("https://directory.example/api/dacs/status"));
    return await response.json() as Record<string, unknown>;
  } finally {
    globalThis.fetch = originalFetch;
    store.saveScanState({ lastSeenTxId: 0, listings: {}, deals: {} });
  }
}

test("status reports no stall when the only unindexed transactions are not yet settled", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: STATUS_NOW });
  const recent = await statusWith(1268, [{ id: 1270 }, { id: 1269 }, { id: 1268 }]);
  assert.equal(recent.chainLatestTx, 1270);
  assert.equal(recent.settledTip, 1268);
  assert.equal(recent.cursorStalled, false);
});

test("a quiet chain shows no stall once the stored first sighting of its tip is old enough and it is indexed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: STATUS_NOW });
  const chain = [{ id: 1270 }, { id: 1269 }, { id: 1268 }];
  const seenAt = (agoMs: number) => ({ id: 1270, since: STATUS_NOW - agoMs });
  const first = await statusWith(1270, chain, [], seenAt(0));
  assert.equal(first.settledTip, 1268);
  assert.equal(first.cursorStalled, false);
  assert.equal((await statusWith(1270, chain, [], seenAt(299_000))).settledTip, 1268);
  const settled = await statusWith(1270, chain, [], seenAt(300_000));
  assert.equal(settled.settledTip, 1270);
  assert.equal(settled.cursorStalled, false);
});

test("status reads the same stored first sighting the indexer writes, so it never sees a longer wait", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: STATUS_NOW });
  const chain = [{ id: 1270 }, { id: 1269 }, { id: 1268 }];
  const absent = await statusWith(1268, chain);
  assert.equal(absent.settledTip, 1268, "no stored sighting: the tip was just seen");
  t.mock.timers.tick(3_600_000);
  const stillAbsent = await statusWith(1268, chain);
  assert.equal(stillAbsent.settledTip, 1268, "the status route does not start its own clock");
  assert.equal(stillAbsent.cursorStalled, false, "the cursor is at the depth-settled tip");
});

test("a tip that has only just become final is not a stall until the threshold has passed since", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: STATUS_NOW });
  const chain = [{ id: 1270 }, { id: 1269 }, { id: 1268 }];
  const justFinal = await statusWith(1268, chain, [], { id: 1270, since: STATUS_NOW - 300_000 });
  assert.equal(justFinal.settledTip, 1270);
  assert.equal(justFinal.secondsSinceCursorAdvanced, 25_200, "the cursor itself last moved long ago");
  assert.equal(justFinal.cursorStalled, false);
  const threshold = justFinal.cursorStallThresholdSeconds as number;
  const waiting = await statusWith(1268, chain, [], { id: 1270, since: STATUS_NOW - 300_000 - (threshold - 1) * 1_000 });
  assert.equal(waiting.cursorStalled, false);
});

test("status reports a stall when the cursor is behind the settled tip past the threshold since it became final", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: STATUS_NOW });
  const chain = [{ id: 1270 }, { id: 1269 }, { id: 1268 }];
  const threshold = (await statusWith(1268, chain)).cursorStallThresholdSeconds as number;
  const stalled = await statusWith(1268, chain, [], { id: 1270, since: STATUS_NOW - 300_000 - threshold * 1_000 });
  assert.equal(stalled.settledTip, 1270);
  assert.equal(stalled.cursorStalled, true);

  const deep = await statusWith(1000, chain);
  assert.equal(deep.settledTip, 1268);
  assert.equal(deep.cursorStalled, true);
  const deepWithSighting = await statusWith(1000, chain, [], { id: 1270, since: STATUS_NOW - 300_000 });
  assert.equal(deepWithSighting.settledTip, 1270);
  assert.equal(deepWithSighting.cursorStalled, true, "ids at the depth boundary were final long before the tip");
});

test("a stored first sighting of another id, a future time or a corrupt record is treated as just seen", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: STATUS_NOW });
  const chain = [{ id: 1271 }, { id: 1270 }, { id: 1269 }];
  for (const stored of [
    { id: 1270, since: STATUS_NOW - 3_600_000 },
    { id: 1271, since: STATUS_NOW + 1 },
    { id: 1271, since: "yesterday" },
    { id: 1271.5, since: 0 },
    { id: 1271, since: -1 },
    "1271",
    null,
  ]) {
    assert.equal((await statusWith(1268, chain, [], stored)).settledTip, 1269, JSON.stringify(stored));
  }
});

test("status does not use transaction timestamps for the settled tip", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: STATUS_NOW });
  const body = await statusWith(1267, [
    { id: 1270, timestamp: STATUS_NOW - SEVEN_HOURS_MS },
    { id: 1269, timestamp: STATUS_NOW - SEVEN_HOURS_MS },
    { id: 1268, timestamp: STATUS_NOW - 5_000 },
  ]);
  assert.equal(body.settledTip, 1268);
});

test("large transaction rows do not hide the chain tip", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: STATUS_NOW });
  const large = (id: number) => ({ id, content: "x".repeat(450_000) });
  const limits: unknown[] = [];
  const body = await statusWith(1268, [large(1270), large(1269), large(1268)], limits);
  assert.deepEqual(limits, [1]);
  assert.equal(body.chainLatestTx, 1270);
  assert.equal(body.settledTip, 1268);
  assert.equal(body.cursorStalled, false);
});

test("status reports an unknown tip for a malformed node reply instead of failing", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: STATUS_NOW });
  for (const chain of [[null], ["x"], [7], [{ id: "1270" }], [], [{ id: 2.5 }], [{ id: -5 }], [{ id: 1e300 }]]) {
    const body = await statusWith(1268, chain);
    assert.equal(body.chainLatestTx, null, JSON.stringify(chain));
    assert.equal(body.settledTip, null, JSON.stringify(chain));
    assert.equal(body.cursorStalled, null, JSON.stringify(chain));
  }
});

test("status leaves the settled tip unknown when the node cannot be read", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: STATUS_NOW });
  store.saveScanState({ lastSeenTxId: 1268, cursorAdvancedAt: STATUS_NOW - SEVEN_HOURS_MS, listings: {}, deals: {} });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("node unreachable"); };
  try {
    const body = await (await statusRoute.GET(new NextRequest("https://directory.example/api/dacs/status"))).json() as Record<string, unknown>;
    assert.equal(body.chainLatestTx, null);
    assert.equal(body.settledTip, null);
    assert.equal(body.cursorStalled, null);
  } finally {
    globalThis.fetch = originalFetch;
    store.saveScanState({ lastSeenTxId: 0, listings: {}, deals: {} });
  }
});

test("status route rejects unsafe queries and exposes a safe exact-locator result", async () => {
  const invalid = await statusRoute.GET(new NextRequest(
    "https://directory.example/api/dacs/status?deadLetterLimit=101",
  ));
  assert.equal(invalid.status, 400);

  const target = locator("5");
  store.recordArtifactFailure(target, "unknown", "STORAGE_UNREADABLE", "raw RPC secret", 1);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    result: 200, response: [{ id: 123 }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const response = await statusRoute.GET(new NextRequest(
      `https://directory.example/api/dacs/status?locator=${target}&deadLetterLimit=1`,
    ));
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(
      catalogStatusSchema.required.filter((field) => !Object.hasOwn(body, field)),
      [],
      "status response contains every property required by its published schema",
    );
    assert.equal(body.chainLatestTx, 123);
    assert.equal(body.settledTip, 121);
    assert.equal(body.cursorAheadBy, 0);
    assert.equal(body.chainResetSuspected, false);
    assert.equal(body.cursorAdvancedAt, null);
    assert.equal(body.secondsSinceCursorAdvanced, null);
    assert.equal(body.cursorStalled, null);
    const indexer = body.indexer as ReturnType<typeof store.indexerDiagnostics>;
    assert.equal(indexer.deadLetterDiagnostics.returned, 1);
    assert.equal(indexer.deadLetterDiagnostics.items[0].locator, target);
    assert.equal(indexer.deadLetterDiagnostics.items[0].classification, "unclassified-storage");
    assert.doesNotMatch(JSON.stringify(indexer.deadLetterDiagnostics), /raw RPC secret/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chain reset cleanup removes active failures but preserves registrations and first-observation history", () => {
  const target = locator("6");
  store.saveRegistrations([{ primaryClaim: "did:demos:agent:registered", displayName: "registered", listingAnchors: [] }]);
  store.recordArtifactFailure(target, "listing", "STORAGE_UNREADABLE", "old chain", 1);
  const firstSeenAt = store.indexerDiagnostics({ deadLetterLocator: target })
    .deadLetterDiagnostics.items[0].firstSeenAt;
  store.clearChainDerivedArtifacts();
  assert.equal(store.indexerDiagnostics().deadLetters, 0);
  assert.equal(store.indexerDiagnostics().listingRejectionDiagnostics.total, 0);
  assert.equal(store.loadRetryableArtifacts(Date.now() + 60_000).length, 0);
  assert.equal(store.loadRegistrations()[0]?.displayName, "registered");

  store.recordArtifactFailure(target, "listing", "STORAGE_UNREADABLE", "replacement chain", 1);
  assert.equal(
    store.indexerDiagnostics({ deadLetterLocator: target }).deadLetterDiagnostics.items[0].firstSeenAt,
    firstSeenAt,
  );
});

test("failure history is bounded: fabricated locators cannot grow it past the ceiling", () => {
  process.env.DACS_FAILURE_HISTORY_MAX_ROWS = "100";
  try {
    const before = store.failureHistorySize();
    for (let i = 0; i < 130; i++) {
      store.recordArtifactFailure(
        `stor-${i.toString(16).padStart(40, "f")}`, "listing", "STORAGE_UNREADABLE", "fabricated",
      );
    }
    assert.ok(before < 100, "fixture assumes the suite starts under the test ceiling");
    assert.equal(store.failureHistorySize(), 100, "ceiling holds no matter how many unique locators arrive");
    // Retention config is clamped, not trusted.
    assert.deepEqual(store.failureHistoryRetention("50", "0"), { maxRows: 5_000, maxAgeMs: 30 * 86_400_000 });
    assert.deepEqual(store.failureHistoryRetention("1000", "7"), { maxRows: 1_000, maxAgeMs: 7 * 86_400_000 });
  } finally {
    delete process.env.DACS_FAILURE_HISTORY_MAX_ROWS;
  }
});

test("age pruning is batched, spares active dead-letters, and resets firstSeenAt on rediscovery", () => {
  const target = locator("9");
  // Promote to an active dead-letter (maxRetries=1) so we can watch its
  // firstSeenAt survive history pruning via the dead_letters copy.
  store.recordArtifactFailure(target, "listing", "STORAGE_UNREADABLE", "boom", 1);
  const original = store.indexerDiagnostics({ deadLetterLocator: target })
    .deadLetterDiagnostics.items[0].firstSeenAt;

  // Everything currently in history is "old" relative to a far-future clock.
  const future = Date.now() + 31 * 86_400_000;
  const populated = store.failureHistorySize();
  assert.ok(populated > 2, "fixture assumes prior tests left history rows");
  // Bounded batches: a single call may not drain, repeated calls do.
  const firstBatch = store.pruneFailureHistory(future, 2);
  assert.equal(firstBatch, 2);
  let guard = 0;
  while (store.pruneFailureHistory(future, 2) > 0 && guard++ < 1_000) { /* drain */ }
  assert.equal(store.failureHistorySize(), 0);

  // The active dead-letter still reports its original firstSeenAt (own copy).
  assert.equal(
    store.indexerDiagnostics({ deadLetterLocator: target }).deadLetterDiagnostics.items[0].firstSeenAt,
    original,
  );

  // Documented rediscovery semantics: pruned history restarts.
  store.recordArtifactFailure(locator("8"), "listing", "STORAGE_UNREADABLE", "fresh", 1);
  assert.equal(store.failureHistorySize(), 1);
});
