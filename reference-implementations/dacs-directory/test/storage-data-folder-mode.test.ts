import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const FOLDER_PERMISSION_BITS = 0o777;
const STORE_FOLDER_MODE = 0o750;
const OPEN_STORE = 'await import("../src/catalog/store.js");';

/** Opens the store in a fresh process whose umask is 0, so only the store's own mode can restrict the folder. */
function openStoreUnderPermissiveUmask(dataDir: string): void {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `process.umask(0); ${OPEN_STORE}`], {
    cwd: new URL("../test/", import.meta.url), encoding: "utf8", timeout: 60_000,
    env: { ...process.env, DACS_DIRECTORY_DATA: dataDir },
  });
  assert.equal(child.status, 0, child.stderr);
}

const folderMode = (path: string) => statSync(path).mode & FOLDER_PERMISSION_BITS;

test("a data folder created by the store is 0750 under a permissive umask", () => {
  const root = mkdtempSync(join(tmpdir(), "dacs-store-mode-"));
  try {
    const dataDir = join(root, "data");
    openStoreUnderPermissiveUmask(dataDir);
    assert.equal(folderMode(dataDir), STORE_FOLDER_MODE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing parent folders of the data folder are created 0750 as well", () => {
  const root = mkdtempSync(join(tmpdir(), "dacs-store-mode-"));
  try {
    const parent = join(root, "state");
    openStoreUnderPermissiveUmask(join(parent, "data"));
    assert.equal(folderMode(parent), STORE_FOLDER_MODE);
    assert.equal(folderMode(join(parent, "data")), STORE_FOLDER_MODE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
