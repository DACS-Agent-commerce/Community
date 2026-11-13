import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("health logs the database-open cause and keeps the 503 body generic", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dacs-health-unopenable-db-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const dbPath = join(dataDir, "directory.sqlite");
  mkdirSync(dataDir, { recursive: true, mode: 0o750 });
  mkdirSync(dbPath);
  const previousDataDir = process.env.DACS_DIRECTORY_DATA;
  process.env.DACS_DIRECTORY_DATA = dataDir;
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.DACS_DIRECTORY_DATA;
    else process.env.DACS_DIRECTORY_DATA = previousDataDir;
  });

  const logged: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logged.push(args); });
  // A separate test file/process keeps the store's import-time configuration isolated.
  const { GET } = await import("../app/api/health/route.js");
  const response = await GET();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "catalog data directory is unavailable" });
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], "Health route failed:");
  const failure = logged[0][1];
  assert.ok(failure instanceof Error);
  assert.ok(failure.message.includes(dbPath));
  const cause = failure.cause;
  assert.ok(cause instanceof Error);
  assert.equal((cause as Error & { code?: string }).code, "SQLITE_CANTOPEN");
  assert.ok(cause.message.trim().length > 0);
  assert.ok(failure.message.includes(cause.message), "wrapper must include the underlying database message");
  assert.doesNotMatch(failure.message, /configure DACS_DIRECTORY_DATA to a writable persistent volume/);
});

test("store path failures retain writable-volume advice and the underlying detail", () => {
  // Import the real store in a fresh process for each import-time data path.
  const script = `
    import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
    import { join } from "node:path";
    import { tmpdir } from "node:os";
    const root = mkdtempSync(join(tmpdir(), "dacs-store-path-"));
    try {
      const file = join(root, "not-a-directory");
      writeFileSync(file, "plain file");
      process.env.DACS_DIRECTORY_DATA = process.env.PATH_CASE === "under-file" ? join(file, "data") : file;
      try { await import("../src/catalog/store.js"); throw new Error("store unexpectedly opened"); }
      catch (error) {
        console.log(JSON.stringify({ message: error.message, code: error.cause?.code, detail: error.cause?.message }));
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  `;
  for (const [pathCase, expectedCode] of [["file", "EEXIST"], ["under-file", "ENOTDIR"]]) {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: new URL(".", import.meta.url), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, PATH_CASE: pathCase },
    });
    assert.equal(child.status, 0, child.stderr);
    const failure = JSON.parse(child.stdout.trim());
    assert.equal(failure.code, expectedCode);
    assert.match(failure.message, /configure DACS_DIRECTORY_DATA to a writable persistent volume/);
    assert.ok(failure.detail.length > 0 && failure.message.includes(failure.detail));
  }
});
