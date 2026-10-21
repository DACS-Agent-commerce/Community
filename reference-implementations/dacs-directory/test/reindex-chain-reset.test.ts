import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-chain-reset-"));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_input, init) => {
  const message = JSON.parse(String(init?.body)).params?.[0]?.message;
  assert.equal(message, "getTransactions");
  return Response.json({ result: 200, response: [{ id: 5 }, { id: 4 }, { id: 3 }, { id: 2 }, { id: 1 }] });
};

process.env.DACS_DIRECTORY_DATA = dataDirectory;
process.env.DEMOS_RPC = "https://rpc.example";
process.env.DACS_SCAN_RESET_THRESHOLD = "1000";

const store = await import("../src/catalog/store.js");
const { reindexAll } = await import("../src/catalog/reindexCore.js");

test.after(() => {
  globalThis.fetch = originalFetch;
  rmSync(dataDirectory, { recursive: true, force: true });
});

test("reindex clears replaced-chain discoveries and rescans from genesis in one run", async () => {
  store.saveScanState({
    schemaVersion: 4,
    lastSeenTxId: 147_262,
    // Old releases retained the high cursor but overwrote this observation
    // with the replacement chain's low tip on every zero-work scan.
    lastChainTip: 5,
    listings: { [`stor-${"a".repeat(40)}`]: `0x${"b".repeat(64)}` },
    publisherListingDiscoveries: {
      "https://old.example": { publisherClaim: `did:demos:agent:${"b".repeat(64)}`, listingAnchors: [`stor-${"a".repeat(40)}`] },
    },
    deals: {},
  });
  store.recordArtifactFailure(`stor-${"c".repeat(40)}`, "listing", "STORAGE_UNREADABLE", "old chain", 1);
  store.saveDomains(["old.example"]);
  const logs: string[] = [];

  const result = await reindexAll({ log: (line) => logs.push(line), crawlWellKnown: async (domains) => {
    assert.deepEqual(domains, ["old.example"]);
    return { agents: [], errors: [{ domain: "old.example", error: "simulated crawl outage" }] };
  } });

  assert.equal(result.cursor, 3, "finality depth leaves the newest two transactions for replay");
  assert.equal(store.loadScanState().schemaVersion, 11);
  assert.deepEqual(Object.keys(store.loadScanState().listings), []);
  assert.deepEqual(Object.keys(store.loadScanState().publisherListingDiscoveries), []);
  assert.equal(store.indexerDiagnostics().deadLetters, 0);
  assert.match(logs[0] ?? "", /chain replacement detected/);
});
