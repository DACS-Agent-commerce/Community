import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

import { parseStatusDiagnosticsQuery } from "../src/catalog/statusDiagnostics.js";

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
    assert.equal(body.chainLatestTx, 123);
    const indexer = body.indexer as ReturnType<typeof store.indexerDiagnostics>;
    assert.equal(indexer.deadLetterDiagnostics.returned, 1);
    assert.equal(indexer.deadLetterDiagnostics.items[0].locator, target);
    assert.equal(indexer.deadLetterDiagnostics.items[0].classification, "unclassified-storage");
    assert.doesNotMatch(JSON.stringify(indexer.deadLetterDiagnostics), /raw RPC secret/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
