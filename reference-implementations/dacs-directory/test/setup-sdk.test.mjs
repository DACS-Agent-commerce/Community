import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("packaged SDK setup enforces the app lockfile and propagates installation failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "dacs-setup-lock-"));
  try {
    mkdirSync(join(directory, "scripts"));
    mkdirSync(join(directory, "vendor/dacs-sdk/dist"), { recursive: true });
    mkdirSync(join(directory, "bin"));
    copyFileSync(new URL("../scripts/setup-sdk.sh", import.meta.url), join(directory, "scripts/setup-sdk.sh"));
    const log = join(directory, "npm-arguments");
    writeFileSync(join(directory, "bin/npm"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$DACS_SETUP_TEST_LOG"\nexit "${DACS_SETUP_TEST_EXIT:-0}"\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${join(directory, "bin")}:${process.env.PATH}`, DACS_SKIP_APP_INSTALL: "0", DACS_SETUP_TEST_LOG: log };
    const run = (extra = {}) => spawnSync("bash", [join(directory, "scripts/setup-sdk.sh")], { env: { ...env, ...extra }, encoding: "utf8" });
    const installed = run();
    assert.equal(installed.status, 0, installed.stderr);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["ci", "--no-audit", "--no-fund"]);
    const failed = run({ DACS_SETUP_TEST_EXIT: "23" });
    assert.equal(failed.status, 23);
    assert.ok(!failed.stdout.includes("setup complete"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
