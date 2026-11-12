import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const mode = (path: string) => statSync(path).mode & 0o777;
const gcrUrl = new URL("../src/catalog/gcr.ts", import.meta.url).href;

function authenticate(dataDir: string, mask = 0): Record<string, string> {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    process.umask(${mask});
    globalThis.fetch = () => { throw new Error("GCR folder test must not make an RPC call"); };
    const { gcrAuthHeaders } = await import(${JSON.stringify(gcrUrl)});
    console.log(JSON.stringify(await gcrAuthHeaders()));
  `], { encoding: "utf8", timeout: 15_000, env: { ...process.env, DACS_DIRECTORY_DATA: dataDir } });
  assert.equal(child.status, 0, child.stderr);
  const headers = JSON.parse(child.stdout);
  assert.match(headers.identity, /^ed25519:0x[0-9a-f]{64}$/);
  assert.match(headers.signature, /^0x[0-9a-f]{128}$/);
  return headers;
}

test("GCR creates a fresh seed folder at 0750 and seed at 0600 under umask 0", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gcr-folder-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, "data");
  authenticate(data);
  assert.equal(mode(data), 0o750);
  assert.equal(mode(join(data, ".indexer-seed")), 0o600);
  assert.match(readFileSync(join(data, ".indexer-seed"), "utf8"), /^[0-9a-f]{64}\n$/);
});

test("GCR creates every missing parent at 0750, including paths with spaces", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gcr-folder-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = join(root, "missing parent");
  const data = join(parent, "more parents", "data folder");
  authenticate(data);
  for (const path of [parent, join(parent, "more parents"), data]) assert.equal(mode(path), 0o750, path);
});

test("GCR preserves existing folder permissions and applies a restrictive umask to new folders", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gcr-folder-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = join(root, "existing");
  mkdirSync(parent);
  chmodSync(parent, 0o777);
  const existing = join(parent, "existing data");
  mkdirSync(existing);
  chmodSync(existing, 0o700);
  authenticate(existing);
  assert.equal(mode(parent), 0o777);
  assert.equal(mode(existing), 0o700);
  const data = join(parent, "new", "data");
  authenticate(data, 0o077);
  assert.equal(mode(parent), 0o777);
  assert.equal(mode(join(parent, "new")), 0o700);
  assert.equal(mode(data), 0o700);
  assert.equal(mode(join(data, ".indexer-seed")), 0o600);
});

test("GCR reuses the existing seed without changing its bytes, timestamps or permissions", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gcr-folder-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o711);
  const seed = join(root, ".indexer-seed");
  const bytes = "07".repeat(32) + "\n";
  writeFileSync(seed, bytes, { mode: 0o400 });
  const before = statSync(seed, { bigint: true });
  const first = authenticate(root);
  const second = authenticate(root);
  const after = statSync(seed, { bigint: true });
  assert.equal(second.identity, first.identity);
  assert.equal(readFileSync(seed, "utf8"), bytes);
  assert.equal(mode(root), 0o711);
  assert.equal(mode(seed), 0o400);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ctimeNs, before.ctimeNs);
});
