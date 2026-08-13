import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-sr2-"));
const locator = `stor-${"a".repeat(40)}`;
const writeHash = "b".repeat(64);
const failedHash = "c".repeat(64);
const unrelatedHash = "d".repeat(64);
const bundle = {
  bundleVersion: "1",
  jobId: "job-sr2-test",
  parties: [],
  anchoredByRole: "buyer",
};
const writeContent = JSON.stringify({
  type: "storageProgram",
  to: locator,
  data: ["storageProgram", {
    operation: "WRITE_STORAGE",
    storageAddress: locator,
    data: bundle,
  }],
});
const transactions = [
  { id: 10, status: "confirmed", type: "transfer", hash: "e".repeat(64), blockNumber: 31, to: "0x1", content: "{}" },
  // This is the only content-producing transaction and the only valid anchor.
  { id: 8, status: "confirmed", type: "storageProgram", hash: writeHash, blockNumber: 30,
    to: locator, timestamp: 9, content: writeContent },
  // Earlier producer timestamps and mere references must not win.
  { id: 7, status: "failed", type: "storageProgram", hash: failedHash, blockNumber: 20,
    to: locator, timestamp: 1, content: writeContent },
  { id: 6, status: "confirmed", type: "transfer", hash: unrelatedHash, blockNumber: 19,
    to: "0x2", timestamp: 2, content: JSON.stringify({ memo: locator }) },
  { id: 1, status: "confirmed", type: "transfer", hash: "f".repeat(64), blockNumber: 1, to: "0x3", content: "{}" },
];

let blockReads = 0;
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === `/storage-program/${locator}`) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: true, owner: `0x${"1".repeat(64)}`, programName: "dacs5:bundle:job-sr2-test", data: bundle }));
    return;
  }
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const call = JSON.parse(body).params?.[0];
    res.setHeader("content-type", "application/json");
    if (call?.message === "getTransactions") {
      const start = call.data?.start;
      const limit = call.data?.limit ?? 100;
      const page = transactions.filter((tx) => start === "latest" || tx.id <= start).slice(0, limit);
      res.end(JSON.stringify({ result: 200, response: page }));
      return;
    }
    if (call?.message === "getBlockByNumber" && call.data?.blockNumber === 30) {
      blockReads += 1;
      res.end(JSON.stringify({ result: 200, response: {
        id: 31,
        number: 30,
        status: "confirmed",
        hash: "9".repeat(64),
        content: { timestamp: 1_785_920_618, ordered_transactions: [writeHash] },
      } }));
      return;
    }
    res.end(JSON.stringify({ result: 200, response: null }));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("test server did not bind");

// Import isolation is security-significant: the store opens SQLite at import.
process.env.DACS_DIRECTORY_DATA = dataDirectory;
process.env.DEMOS_RPC = `http://127.0.0.1:${address.port}`;
process.env.DACS_SCAN_FINALITY_DEPTH = "0";

const { contentHash } = await import("@kynesyslabs/dacs/canonical");
const { scanChain, scanConsensusAnchorBackfill } = await import("../src/catalog/scan.js");
const store = await import("../src/catalog/store.js");

test.after(() => {
  server.close();
  rmSync(dataDirectory, { recursive: true, force: true });
});

test("SR-2 uses confirmed block time and ignores failed or unrelated references", async () => {
  const result = await scanChain(null, { maxTxs: 100, sinceTxId: 0 });
  const observation = result.observations.find((item) => item.locator === locator);

  assert.equal(observation?.anchorTime, 1_785_920_618_000);
  assert.equal(observation?.contentHash, contentHash(bundle));
  assert.equal(blockReads, 1, "only the exact confirmed write causes a block lookup");
});

test("SR-2 historical scanning is bounded and resumes from its returned cursor", async () => {
  const targets = new Map([[locator, contentHash(bundle)]]);
  const first = await scanConsensusAnchorBackfill(targets, { maxTxs: 2, budgetMs: 5_000 });

  assert.equal(first.complete, false);
  assert.equal(first.nextCursor, 7);
  assert.equal(first.txsScanned, 2);
  assert.deepEqual(first.observations, [{ locator, contentHash: contentHash(bundle), anchorTime: 1_785_920_618_000 }]);

  const second = await scanConsensusAnchorBackfill(targets, { cursor: first.nextCursor, maxTxs: 2, budgetMs: 5_000 });
  assert.equal(second.nextCursor, 5);
  assert.equal(second.observations.length, 0);
});

test("stored anchor time is hash-bound and retains the earliest consensus observation", () => {
  const first = { value: "first" };
  const second = { value: "second" };
  const storedLocator = `stor-${"2".repeat(40)}`;
  store.recordArtifact({ locator: storedLocator, kind: "bundle", profile: "dacs-v0.1",
    contentHash: contentHash(first), observedAt: 1, anchorTime: 200, data: first });
  store.recordArtifact({ locator: storedLocator, kind: "bundle", profile: "dacs-v0.1",
    contentHash: contentHash(first), observedAt: 2, anchorTime: 300, data: first });
  assert.equal(store.artifactAnchorTime(storedLocator), 200);

  store.recordArtifact({ locator: storedLocator, kind: "bundle", profile: "dacs-v0.1",
    contentHash: contentHash(second), observedAt: 3, data: second });
  assert.equal(store.artifactAnchorTime(storedLocator), undefined, "an overwrite cannot inherit the old content's time");

  assert.equal(store.recordConsensusAnchors([{ locator: storedLocator, contentHash: contentHash(first), anchorTime: 100 }]), 0);
  assert.equal(store.recordConsensusAnchors([{ locator: storedLocator, contentHash: contentHash(second), anchorTime: 400 }]), 1);
  assert.equal(store.artifactAnchorTime(storedLocator), 400);
});
