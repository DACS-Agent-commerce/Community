import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-chain-reset-"));
const server = createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const message = JSON.parse(body).params?.[0]?.message;
    res.setHeader("content-type", "application/json");
    if (message !== "getTransactions") {
      res.end(JSON.stringify({ result: 400, response: null }));
      return;
    }
    res.end(JSON.stringify({
      result: 200,
      response: [{ id: 5 }, { id: 4 }, { id: 3 }, { id: 2 }, { id: 1 }],
    }));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("test server did not bind");

process.env.DACS_DIRECTORY_DATA = dataDirectory;
process.env.DEMOS_RPC = `http://127.0.0.1:${address.port}`;
process.env.DACS_SCAN_RESET_THRESHOLD = "1000";

const store = await import("../src/catalog/store.js");
const { reindexAll } = await import("../src/catalog/reindexCore.js");

test.after(() => {
  server.close();
  rmSync(dataDirectory, { recursive: true, force: true });
});

test("reindex clears replaced-chain discoveries and rescans from genesis in one run", async () => {
  store.saveScanState({
    schemaVersion: 4,
    lastSeenTxId: 147_262,
    lastChainTip: 147_264,
    listings: { [`stor-${"a".repeat(40)}`]: `0x${"b".repeat(64)}` },
    deals: {},
  });
  store.recordArtifactFailure(`stor-${"c".repeat(40)}`, "listing", "STORAGE_UNREADABLE", "old chain", 1);
  const logs: string[] = [];

  const result = await reindexAll({ log: (line) => logs.push(line) });

  assert.equal(result.cursor, 3, "finality depth leaves the newest two transactions for replay");
  assert.deepEqual(store.loadScanState().listings, {});
  assert.equal(store.indexerDiagnostics().deadLetters, 0);
  assert.match(logs[0] ?? "", /chain replacement detected/);
});
