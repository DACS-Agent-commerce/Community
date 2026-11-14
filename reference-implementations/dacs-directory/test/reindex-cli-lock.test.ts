import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

class ChildTimeoutError extends Error {
  constructor(public readonly pid: number | undefined, public readonly result: ChildResult) {
    super("child timed out and was reaped");
  }
}

// Capture exit status at exit, but settle only after close has drained both pipes.
// A hung regression must be killed and reaped before its data directory is removed.
function runChild(source: string, directory: string, timeoutMs = 20_000): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
      env: { ...process.env, DACS_DIRECTORY_DATA: directory },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let code: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError: Error | undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("exit", (exitCode, exitSignal) => { code = exitCode; signal = exitSignal; });
    child.once("error", error => { spawnError = error; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      const result = { code, signal, stdout, stderr };
      if (spawnError) reject(spawnError);
      else if (timedOut) reject(new ChildTimeoutError(child.pid, result));
      else resolve(result);
    });
  });
}


test("scheduled CLI exits successfully when another reindex holds the lease", { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "dacs-reindex-cli-"));
  const storeUrl = new URL("../src/catalog/store.ts", import.meta.url).href;
  const cliUrl = new URL("../src/catalog/reindex.ts", import.meta.url).href;
  const source = `
    const { withDataLock } = await import(${JSON.stringify(storeUrl)});
    await withDataLock("reindex", async () => {
      await import(${JSON.stringify(cliUrl)});
      await new Promise(() => {});
    });
  `;
  try {
    const started = Date.now();
    const { code, stdout, stderr } = await runChild(source, directory);
    console.log(JSON.stringify({ elapsedMs: Date.now() - started, code, stdout, stderr }));
    assert.equal(code, 0, `busy scheduled pass should succeed: ${stderr}`);
    assert.match(stdout, /reindex skipped: another reindex holds the data lease/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lease acquires after release, preserves callback errors, and recovers expired leases", { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "dacs-reindex-boundary-"));
  const storeUrl = new URL("../src/catalog/store.ts", import.meta.url).href;
  const source = `
    import assert from "node:assert/strict";
    import Database from "better-sqlite3";
    import { join } from "node:path";
    const { withDataLock } = await import(${JSON.stringify(storeUrl)});
    let acquired;
    const ready = new Promise(resolve => { acquired = resolve; });
    const first = withDataLock("reindex", async () => {
      acquired();
      await new Promise(resolve => setTimeout(resolve, 100));
    });
    await ready;
    let calls = 0;
    const second = withDataLock("reindex", () => ++calls);
    await first;
    assert.equal(await second, 1);
    const failure = new Error("callback failed");
    await assert.rejects(withDataLock("reindex", () => { throw failure; }), error => error === failure);
    assert.equal(await withDataLock("reindex", () => "released"), "released");
    const db = new Database(join(process.env.DACS_DIRECTORY_DATA, "directory.sqlite"));
    db.prepare("INSERT INTO leases(name, token, expires_at) VALUES (?, ?, ?)").run("reindex", "expired", Date.now() - 1);
    assert.equal(await withDataLock("reindex", () => "recovered"), "recovered");
    assert.equal(db.prepare("SELECT count(*) AS n FROM leases WHERE name = ?").get("reindex").n, 0);
    db.close();
  `;
  try {
    const { code, stderr } = await runChild(source, directory);
    assert.equal(code, 0, stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test("child completion drains large stdout and stderr and retains a non-zero exit", { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "dacs-child-output-"));
  try {
    const result = await runChild(`
      process.stdout.write("o".repeat(512 * 1024));
      process.stderr.write("\\n" + "e".repeat(512 * 1024) + "\\n");
      process.exitCode = 7;
    `, directory, 5_000);
    assert.equal(result.code, 7);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "o".repeat(512 * 1024));
    assert.ok(result.stderr.split("\n").includes("e".repeat(512 * 1024)), "stderr payload must drain completely");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a timed-out lease child is killed and reaped before cleanup", { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "dacs-child-timeout-"));
  const storeUrl = new URL("../src/catalog/store.ts", import.meta.url).href;
  try {
    await assert.rejects(runChild(`
      const { withDataLock } = await import(${JSON.stringify(storeUrl)});
      await withDataLock("reindex", async () => {
        console.log("lease held");
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      });
    `, directory, 3_000), error => {
      assert.ok(error instanceof ChildTimeoutError);
      assert.match(error.result.stdout, /lease held/);
      assert.equal(error.result.signal, "SIGKILL");
      assert.equal(error.result.code, null);
      assert.ok(error.pid);
      assert.throws(() => process.kill(error.pid!, 0), { code: "ESRCH" });
      return true;
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Execute the exact CLI bytes in a disposable fixture. Only reindexAll is replaced
// to force callback errors without RPC; the lease store and error class are real.
async function cliFailure(callback: string): Promise<ChildResult> {
  const directory = mkdtempSync(join(tmpdir(), "dacs-cli-failure-"));
  const storeUrl = new URL("../src/catalog/store.ts", import.meta.url).href;
  const cli = readFileSync(new URL("../src/catalog/reindex.ts", import.meta.url), "utf8");
  try {
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    writeFileSync(join(directory, "reindex.mjs"), cli);
    writeFileSync(join(directory, "store.js"), `export * from ${JSON.stringify(storeUrl)};`);
    writeFileSync(join(directory, "reindexCore.js"), `
      import { withDataLock } from ${JSON.stringify(storeUrl)};
      export async function reindexAll() { ${callback} }
    `);
    return await runChild(`await import(${JSON.stringify(new URL("file://" + join(directory, "reindex.mjs")).href)});`, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("CLI callback failure exits non-zero and is not logged as contention", { timeout: 25_000 }, async () => {
  const result = await cliFailure('throw new Error("callback failed");');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /reindex failed: callback failed/);
  assert.doesNotMatch(result.stdout, /reindex skipped/);
});

test("CLI timeout for another lease exits non-zero", { timeout: 25_000 }, async () => {
  const result = await cliFailure(`
    await withDataLock("other", async () => {
      await withDataLock("other", () => { throw new Error("must not acquire"); });
    });
  `);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /reindex failed: timed out waiting for other data lease/);
  assert.doesNotMatch(result.stdout, /reindex skipped/);
});

test("an untyped timeout-like callback error remains a CLI failure", { timeout: 25_000 }, async () => {
  const result = await cliFailure('throw new Error("timed out waiting for reindex data lease");');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /reindex failed: timed out waiting for reindex data lease/);
  assert.doesNotMatch(result.stdout, /reindex skipped/);
});


test("CLI same-name lease timeout after callback starts remains a failure", { timeout: 25_000 }, async () => {
  const result = await cliFailure(`
    await withDataLock("reindex", () => { throw new Error("must not acquire"); });
  `);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /reindex failed: timed out waiting for reindex data lease/);
  assert.doesNotMatch(result.stdout, /reindex skipped/);
});
