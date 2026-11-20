import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";

const app = fileURLToPath(new URL("../", import.meta.url));
const cli = new URL("../src/catalog/reindex.ts", import.meta.url).href;
const storeUrl = new URL("../src/catalog/store.ts", import.meta.url).href;
const fixtureUrl = new URL("./fixtures/kit-listing.ts", import.meta.url).href;
const statusUrl = new URL("../app/api/dacs/status/route.ts", import.meta.url).href;
const nextUrl = import.meta.resolve("next/server");
const tsx = import.meta.resolve("tsx");
const profile = { DACS_DIRECTORY_NETWORK: "testnet", DEMOS_RPC: "https://rpc.testnet.example.org",
  NEXT_PUBLIC_DEMOS_RPC: "https://rpc.testnet.example.org" };

// Snapshot every persisted table except the run being added and the lease used to add it.
// This includes raw legacy state and chain-read bookkeeping, not just the cursor.
function snapshot(db: Database.Database): Record<string, unknown> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('scan_runs','leases','sqlite_sequence') ORDER BY name")
    .all() as Array<{ name: string }>;
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare('SELECT * FROM "' + name + '"').all()]));
}
type Scenario = "network" | "missing-build" | "built-rpc" | "wrong-chain" | "unreadable-node" | "success" | "busy";

function withCLI(scenario: Scenario, prior: boolean, inspect: (result: ReturnType<typeof spawnSync>,
  db: Database.Database, directory: string, env: NodeJS.ProcessEnv) => void,
  options: { plain?: boolean; pending?: boolean } = {}): void {
  const directory = mkdtempSync(join(tmpdir(), "dacs-reindex-startup-"));
  const data = join(directory, "data");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, TMPDIR: tmpdir(), NODE_ENV: "test", ...profile,
    DACS_DIRECTORY_DATA: data, TSX_TSCONFIG_PATH: join(app, "tsconfig.json") };
  if (scenario === "network" || scenario === "busy" || options.plain) env.DACS_DIRECTORY_NETWORK = "mainnet";
  if (scenario !== "missing-build") {
    const route = join(directory, ".next/server/app/.well-known/dacs-directory.json");
    mkdirSync(route, { recursive: true });
    const rpc = scenario === "built-rpc" ? "https://different.example.org" : profile.NEXT_PUBLIC_DEMOS_RPC;
    writeFileSync(join(route, "route.js"), `module.exports = { routeModule: { userland: {
      GET: async () => Response.json({ substrates: { demos: { rpcUrl: ${JSON.stringify(rpc)} } } })
    } } };`);
  }
  const runner = join(directory, "runner.mjs");
  writeFileSync(runner, `
    import Database from ${JSON.stringify(import.meta.resolve("better-sqlite3"))};
    import { writeFileSync, appendFileSync } from "node:fs";
    import { join } from "node:path";
    import { FixtureNode } from ${JSON.stringify(fixtureUrl)};
    const store = await import(${JSON.stringify(storeUrl)});
    const db = new Database(join(process.env.DACS_DIRECTORY_DATA, "directory.sqlite"));
    const successful = ${scenario === "success"};
    const node = new FixtureNode();
    if (${scenario === "wrong-chain"}) node.chainIdentity = "ef".repeat(32);
    if (${scenario === "unreadable-node"}) node.down = true;
    const trace = join(${JSON.stringify(directory)}, "requests.jsonl");
    globalThis.fetch = async (input, init) => {
      appendFileSync(trace, JSON.stringify(JSON.parse(String(init?.body ?? "{}"))) + "\\n");
      return node.fetch(input, init);
    };
    const cursor = successful ? 0 : 37;
    store.saveRegistrations([]);
    store.saveDomains([]);
    store.saveScanState({ ...store.loadScanState(), lastSeenTxId: cursor });
    const catalog = { catalogVersion: "1", generatedAt: 7, sellers: [] };
    store.saveCatalog(catalog);
    if (successful) store.publishCatalogChain(catalog, store.loadScanState(), node.chainIdentity);
    else {
      store.invalidateCatalogChain("ab".repeat(32));
      // A preflight refusal must not consume legacy state after interrupted-pass rollback.
      const legacy = { schemaVersion: 0, lastSeenTxId: cursor, listings: {}, deals: {},
        programs: { unvisited: null }, chainIdentity: "ab".repeat(32) };
      db.prepare("UPDATE kv_state SET value_json=? WHERE key='scan-state'").run(JSON.stringify(legacy));
    }
    if (${prior}) store.finishScanRun(store.beginScanRun(cursor),
      { toTx: cursor, txs: 0, artifacts: 0, rejected: 0 });
    writeFileSync(join(${JSON.stringify(directory)}, "before.json"), JSON.stringify((${snapshot.toString()})(db)));
    if (${options.pending === true}) {
      store.openChainReadWindow();
      store.admitRevocationCandidates("cd".repeat(32), [{ locator: "stor-" + "de".repeat(20) }]);
      store.saveScanState({ ...store.loadScanState(), lastSeenTxId: 99 });
      writeFileSync(join(${JSON.stringify(directory)}, "dirty.json"), JSON.stringify((${snapshot.toString()})(db)));
    }
    if (${scenario === "busy"}) {
      await store.withDataLock("reindex", async () => {
        writeFileSync(join(${JSON.stringify(directory)}, "lease.json"), JSON.stringify(db.prepare("SELECT * FROM leases WHERE name='reindex'").get()));
        await import(${JSON.stringify(cli)});
        await new Promise(() => {});
      });
    } else await import(${JSON.stringify(cli)});
  `);
  let db: Database.Database | undefined;
  try {
    const result = spawnSync(process.execPath, ["--import", tsx, runner, ...(options.plain ? [] : ["--testnet"])],
      { cwd: directory, env, encoding: "utf8", timeout: 25_000, killSignal: "SIGKILL" });
    assert.ifError(result.error);
    assert.equal(result.signal, null, String(result.stderr));
    db = new Database(join(data, "directory.sqlite"));
    inspect(result, db, directory, env);
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function requests(directory: string): Array<{ params?: Array<{ message?: string }> }> {
  try { return readFileSync(join(directory, "requests.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

function publicStatus(env: NodeJS.ProcessEnv, directory: string): { syncedToTx: number;
  indexer: { lastRun: { status: string; from_tx: number; to_tx: number; chain_tip: number | null; error?: unknown } } } {
  const source = `
    import { NextRequest } from ${JSON.stringify(nextUrl)};
    globalThis.fetch = async () => { throw new Error("offline status tip"); };
    const { GET } = await import(${JSON.stringify(statusUrl)});
    const response = await GET(new NextRequest("http://localhost/api/dacs/status"));
    if (response.status !== 200) throw new Error("status route failed: " + response.status);
    console.log(JSON.stringify(await response.json()));
  `;
  const child = spawnSync(process.execPath, ["--import", tsx, "--input-type=module", "--eval", source],
    { cwd: directory, env, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" });
  assert.ifError(child.error);
  assert.equal(child.status, 0, String(child.stderr));
  return JSON.parse(String(child.stdout));
}

const refusals: Array<[Scenario, RegExp, boolean]> = [
  ["network", /DACS_DIRECTORY_NETWORK must be "testnet"/, true],
  ["missing-build", /could not read the built manifest RPC/, true],
  ["built-rpc", /built manifest RPC must match NEXT_PUBLIC_DEMOS_RPC/, true],
  ["wrong-chain", /serves chain .*not the pinned chain/, false],
  ["unreadable-node", /could not read the Demos node's chain/, false],
];

for (const prior of [false, true]) for (const [scenario, reason, beforeNetwork] of refusals) {
  test(`testnet CLI ${scenario} records one failed run with ${prior ? "completed" : "empty"} history`, () => {
    withCLI(scenario, prior, (result, db, directory, env) => {
      assert.equal(result.status, 1, String(result.stderr));
      assert.match(String(result.stderr), /reindex failed: refusing to start:/);
      assert.match(String(result.stderr), reason);
      const rows = db.prepare("SELECT * FROM scan_runs ORDER BY id").all() as Array<Record<string, unknown>>;
      assert.equal(rows.length, prior ? 2 : 1);
      if (prior) assert.equal(rows[0].status, "complete");
      const run = rows.at(-1)!;
      assert.equal(run.status, "failed");
      assert.match(String(run.error), reason);
      assert.equal(run.from_tx, 37);
      assert.equal(run.to_tx, 37);
      assert.equal(run.chain_tip, null);
      assert.ok(typeof run.finished_at === "number" && run.finished_at >= Number(run.started_at));
      for (const field of ["txs_scanned", "artifacts_observed", "rejected", "omitted_sellers", "omitted_bindings", "omitted_deals"]) assert.equal(run[field], 0, field);
      assert.deepEqual(snapshot(db), JSON.parse(readFileSync(join(directory, "before.json"), "utf8")));
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM leases").get() as { n: number }).n, 0);
      const calls = requests(directory);
      if (beforeNetwork) assert.deepEqual(calls, []);
      else assert.ok(calls.length > 0);
      assert.equal(calls.some(call => call.params?.[0]?.message === "getTransactions"), false, "refusal must precede scanning");
      const status = publicStatus(env, directory);
      assert.equal(status.syncedToTx, 37);
      assert.equal(status.indexer.lastRun.status, "failed");
      assert.equal(status.indexer.lastRun.from_tx, 37);
      assert.equal(status.indexer.lastRun.to_tx, 37);
      assert.equal(status.indexer.lastRun.chain_tip, null);
      assert.equal(Object.hasOwn(status.indexer.lastRun, "error"), false);
    });
  });
}

test("testnet preflight refusal records the saved cursor after interrupted-pass rollback", () => {
  withCLI("network", true, (result, db, directory) => {
    assert.equal(result.status, 1, String(result.stderr));
    assert.match(String(result.stderr), /refusing to start: DACS_DIRECTORY_NETWORK/);
    const before = JSON.parse(readFileSync(join(directory, "before.json"), "utf8"));
    const dirty = JSON.parse(readFileSync(join(directory, "dirty.json"), "utf8"));
    assert.ok(dirty.unconfirmed_chain_writes.length > 0, "fixture must contain pending writes");
    assert.deepEqual(snapshot(db), before);
    assert.deepEqual(db.prepare("SELECT status,from_tx,to_tx FROM scan_runs ORDER BY id DESC LIMIT 1").get(),
      { status: "failed", from_tx: 37, to_tx: 37 });
  }, { pending: true });
});

test("a passing testnet preflight reaches indexing and creates only the index run", () => {
  withCLI("success", false, (result, db, directory) => {
    assert.equal(result.status, 0, String(result.stderr));
    assert.match(String(result.stdout), /catalog written/);
    const rows = db.prepare("SELECT status FROM scan_runs").all();
    assert.deepEqual(rows, [{ status: "complete" }]);
    assert.ok(requests(directory).some(call => call.params?.[0]?.message === "getTransactions"));
  });
});

test("plain index retains its existing profile without the deployment-only testnet gate", () => {
  withCLI("success", false, (result, db) => {
    assert.equal(result.status, 0, String(result.stderr));
    assert.deepEqual(db.prepare("SELECT status FROM scan_runs").all(), [{ status: "complete" }]);
  }, { plain: true });
});

test("busy testnet CLI skips without running its invalid-profile preflight or recording failure", { timeout: 30_000 }, () => {
  withCLI("busy", true, (result, db, directory) => {
    assert.equal(result.status, 0, String(result.stderr));
    assert.match(String(result.stdout), /reindex skipped: another reindex holds the data lease/);
    assert.doesNotMatch(String(result.stderr), /refusing to start|reindex failed/);
    assert.deepEqual(db.prepare("SELECT status FROM scan_runs").all(), [{ status: "complete" }]);
    assert.deepEqual(db.prepare("SELECT * FROM leases WHERE name='reindex'").get(), JSON.parse(readFileSync(join(directory, "lease.json"), "utf8")));
    assert.deepEqual(requests(directory), []);
  });
});
