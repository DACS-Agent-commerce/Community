import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const mode = (path) => statSync(path).mode & 0o777;

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "railway-folder-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["scripts", "bin", "node_modules/.bin", "data"]) mkdirSync(join(root, dir), { recursive: true });
  // Execute the repository's complete startup and runtime-check scripts, byte for byte.
  for (const file of ["start-railway.sh", "check-node-runtime.mjs"]) copyFileSync(join(appDir, "scripts", file), join(root, "scripts", file));
  writeFileSync(join(root, ".nvmrc"), process.versions.node + "\n");
  writeFileSync(join(root, "data/registrations.example.json"), '{"fixture":true}\n');
  symlinkSync(process.execPath, join(root, "bin/node"));
  const script = (path, body) => writeFileSync(join(root, path), "#!/bin/bash\nset -eu\n" + body, { mode: 0o755 });
  script("bin/npm", `
    printf 'npm:%s:%s\\n' "$*" "$DACS_DIRECTORY_DATA" >> "$FIXTURE_ROOT/events"
    if [ ! -f "$FIXTURE_ROOT/first-index" ]; then
      touch "$FIXTURE_ROOT/first-index"
      exit 23
    fi
    touch "$FIXTURE_ROOT/second-index"
  `);
  // Permit one retry, then end the indexer loop without leaving a sleeping child.
  script("bin/sleep", `
    printf 'sleep:%s\\n' "$*" >> "$FIXTURE_ROOT/events"
    if [ -f "$FIXTURE_ROOT/slept" ]; then touch "$FIXTURE_ROOT/indexer-done"; exit 1; fi
    touch "$FIXTURE_ROOT/slept"
  `);
  script("node_modules/.bin/next", `
    printf 'next:%s:%s\\n' "$*" "$DACS_DIRECTORY_DATA" >> "$FIXTURE_ROOT/events"
    for ((i=0; i<200; i++)); do
      if [ -f "$FIXTURE_ROOT/indexer-done" ]; then exit 0; fi
      /bin/sleep 0.01
    done
    exit 25
  `);
  return root;
}

function start(root, data, mask = "0", volume = "") {
  const fd = openSync(join(root, "output"), "w");
  let child;
  try {
    child = spawnSync("/bin/bash", ["-c", 'umask "$1"; exec /bin/bash scripts/start-railway.sh', "railway-test", mask], {
      cwd: root, timeout: 10_000, stdio: ["ignore", fd, fd],
      env: { ...process.env, NODE_OPTIONS: "", PATH: `${join(root, "bin")}:/usr/bin:/bin`, FIXTURE_ROOT: root,
        DACS_DIRECTORY_DATA: data, RAILWAY_VOLUME_MOUNT_PATH: volume, DACS_INDEX_INTERVAL_SECONDS: "17", PORT: "4321" },
    });
  } finally { closeSync(fd); }
  const output = readFileSync(join(root, "output"), "utf8");
  assert.equal(child.error, undefined, String(child.error));
  return { status: child.status, output };
}

function successfulStart(root, data, mask = "0", volume = "") {
  const run = start(root, data, mask, volume);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /\[indexer\] refresh failed/);
  const selected = data || volume || join(root, "data");
  const events = readFileSync(join(root, "events"), "utf8").trim().split("\n");
  assert.equal(events.filter((x) => x === `npm:run index:${selected}`).length, 2);
  assert.equal(events.filter((x) => x === `next:start -p 4321:${selected}`).length, 1);
  assert.equal(events.filter((x) => x === "sleep:17").length, 2);
  return selected;
}

test("Railway creates a fresh final directory at 0750 under umask 0", (t) => {
  const root = fixture(t);
  const data = join(root, "fresh");
  successfulStart(root, data);
  assert.equal(mode(data), 0o750);
  assert.equal(readFileSync(join(data, "registrations.json"), "utf8"), '{"fixture":true}\n');
});

test("Railway creates every missing parent at 0750, including spaces", (t) => {
  const root = fixture(t);
  const parent = join(root, "missing parent");
  const data = join(parent, "more parents", "data folder");
  successfulStart(root, data);
  for (const path of [parent, join(parent, "more parents"), data]) assert.equal(mode(path), 0o750, path);
});

test("Railway leaves existing directory permissions and registrations unchanged", (t) => {
  const root = fixture(t);
  const parent = join(root, "existing");
  const data = join(parent, "data");
  mkdirSync(data, { recursive: true });
  chmodSync(parent, 0o777);
  chmodSync(data, 0o700);
  writeFileSync(join(data, "registrations.json"), "existing registration\n");
  successfulStart(root, data);
  assert.equal(mode(parent), 0o777);
  assert.equal(mode(data), 0o700);
  assert.equal(readFileSync(join(data, "registrations.json"), "utf8"), "existing registration\n");
});

test("Railway respects umask 077 for every new directory under an existing parent", (t) => {
  const root = fixture(t);
  const parent = join(root, "existing");
  mkdirSync(parent);
  chmodSync(parent, 0o711);
  const data = join(parent, "new", "data");
  successfulStart(root, data, "077");
  assert.equal(mode(parent), 0o711);
  assert.equal(mode(join(parent, "new")), 0o700);
  assert.equal(mode(data), 0o700);
});

for (const choice of ["explicit", "volume", "default", "empty-explicit"]) {
  test(`Railway preserves data-path precedence: ${choice}`, (t) => {
    const root = fixture(t);
    const explicit = join(root, "explicit data");
    const volume = join(root, "volume data");
    const selected = successfulStart(root, choice === "explicit" ? explicit : choice === "empty-explicit" ? "" : undefined, "0", choice === "default" ? "" : volume);
    assert.equal(selected, choice === "explicit" ? explicit : choice === "default" ? join(root, "data") : volume);
    assert.ok(existsSync(join(selected, "registrations.json")));
    if (choice !== "explicit") assert.ok(!existsSync(explicit));
    if (choice === "explicit" || choice === "default") assert.ok(!existsSync(volume));
  });
}

test("Railway refuses a wrong Node version before folders, registration copy or services", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, ".nvmrc"), "0.0.0\n");
  const parent = join(root, "must not exist");
  const run = start(root, join(parent, "data"));
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /\[deployment config\] Node .* is running, but \.nvmrc pins 0\.0\.0/);
  assert.ok(!existsSync(parent));
  assert.ok(!existsSync(join(root, "events")));
});
