import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

test("fresh SQLite storage opens safely in concurrent processes", { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "dacs-directory-store-"));
  const gate = join(directory, "start");
  const blocker = new Database(join(directory, "directory.sqlite"));
  blocker.exec("BEGIN EXCLUSIVE");
  const storeUrl = new URL("../src/catalog/store.ts", import.meta.url).href;
  const source = `
    import { existsSync } from "node:fs";
    process.stdout.write("ready\\n");
    while (!existsSync(process.env.DACS_TEST_GATE)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await import(${JSON.stringify(storeUrl)});
  `;

  const children = Array.from({ length: 8 }, () => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
      env: { ...process.env, DACS_DIRECTORY_DATA: directory, DACS_TEST_GATE: gate },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.setEncoding("utf8");
      child.stdout.once("data", (chunk) => {
        if (String(chunk).includes("ready")) resolve();
        else reject(new Error(`storage worker did not become ready: ${chunk}`));
      });
      child.once("exit", (code) => reject(new Error(`storage worker exited ${code} before becoming ready: ${stderr}`)));
      child.once("error", reject);
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`storage worker exited ${code}: ${stderr}`)));
      child.once("error", reject);
    });
    return { ready, exited };
  });

  try {
    await Promise.all(children.map((child) => child.ready));
    writeFileSync(gate, "go");
    await new Promise((resolve) => setTimeout(resolve, 200));
    blocker.exec("COMMIT");
    blocker.close();
    await Promise.all(children.map((child) => child.exited));
    assert.equal(existsSync(join(directory, "directory.sqlite")), true);
  } finally {
    if (!existsSync(gate)) writeFileSync(gate, "go");
    if (blocker.open) {
      if (blocker.inTransaction) blocker.exec("ROLLBACK");
      blocker.close();
    }
    await Promise.allSettled(children.map((child) => child.exited));
    rmSync(directory, { recursive: true, force: true });
  }
});
