import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const FOLDER_PERMISSION_BITS = 0o777;
const STORE_FOLDER_MODE = 0o750;
const CALL_HEALTH_ROUTE = `
  const { GET } = await import("../app/api/health/route.js");
  await GET();
`;

/** Calls the health route in a fresh process whose umask is 0, so only the route's own mode can restrict the folder. */
function callHealthRouteUnderPermissiveUmask(dataDir: string): void {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `process.umask(0); ${CALL_HEALTH_ROUTE}`], {
    cwd: new URL("../test/", import.meta.url), encoding: "utf8", timeout: 60_000,
    env: { ...process.env, DACS_DIRECTORY_DATA: dataDir },
  });
  assert.equal(child.status, 0, child.stderr);
}

test("a data folder first created by the health route is 0750 under a permissive umask", () => {
  const root = mkdtempSync(join(tmpdir(), "dacs-health-mode-"));
  try {
    const dataDir = join(root, "data");
    callHealthRouteUnderPermissiveUmask(dataDir);
    assert.equal(statSync(dataDir).mode & FOLDER_PERMISSION_BITS, STORE_FOLDER_MODE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
