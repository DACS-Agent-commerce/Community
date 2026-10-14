import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const app = fileURLToPath(new URL("../", import.meta.url));
const guide = readFileSync(new URL("../../../docs/codex-local-workflow.md", import.meta.url), "utf8");
const blocks = [...guide.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]);
const install = blocks.find((block) => block.includes("sdk_rev="));
const checks = blocks.find((block) => block.includes("npm run typecheck"));
assert.ok(install && checks, "documented install and check commands are present");
const realGit = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const gitPathVariables = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_SHALLOW_FILE",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
];

function snapshot(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => [
    entry.name, entry.isDirectory() ? snapshot(join(directory, entry.name)) : readFileSync(join(directory, entry.name)),
  ]);
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "dacs-local-workflow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const cwd = join(root, "app");
  const temporary = join(root, "temporary");
  for (const path of [bin, cwd, temporary]) mkdirSync(path);
  const log = join(root, "commands.jsonl");
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: temporary,
    WORKFLOW_LOG: log, WORKFLOW_REAL_GIT: realGit, WORKFLOW_APP: app,
    DACS_DIRECTORY_DATA: join(cwd, "data"),
  };
  writeFileSync(join(bin, "git"), `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.some(a => ['clone', 'fetch', 'checkout'].includes(a))) {
  const gitPaths = Object.fromEntries(${JSON.stringify(gitPathVariables)}.filter(key => key in process.env).map(key => [key, process.env[key]]));
  appendFileSync(process.env.WORKFLOW_LOG, JSON.stringify({tool:'git', args, gitPaths})+'\\n');
  if (args.includes('fetch')) process.exit(0); // The pin is already available offline.
  if (args[0] === 'clone') args.splice(1, args.length-2, '--no-local', process.env.WORKFLOW_SDK_SOURCE);
}
const run = spawnSync(process.env.WORKFLOW_REAL_GIT, args, {stdio:'inherit'});
process.exit(run.status ?? 1);
`, { mode: 0o755 });
  writeFileSync(join(bin, "npm"), `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
appendFileSync(process.env.WORKFLOW_LOG, JSON.stringify({tool:'npm', args, data:process.env.DACS_DIRECTORY_DATA})+'\\n');
if (args[0] === 'test' || (args[1] === 'build' && process.env.WORKFLOW_CHECKS)) {
  const run = spawnSync(process.execPath, ['--import','tsx','--input-type=module','--eval',
    'await import("./src/catalog/indexer.ts")'], {cwd:process.env.WORKFLOW_APP, env:process.env, stdio:'inherit'});
  if (run.status !== 0) process.exit(run.status ?? 1);
}
if (args[0] === 'test' && process.env.WORKFLOW_FAIL_TEST) process.exit(23);
`, { mode: 0o755 });
  const run = (block) => spawnSync("bash", ["-c", block], { cwd, env, encoding: "utf8", timeout: 30_000 });
  const commands = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
  return { root, cwd, temporary, env, run, commands };
}

function sdkFixture(f) {
  const source = join(f.root, "source-sdk");
  mkdirSync(source);
  const git = (...args) => execFileSync(realGit, ["-C", source, ...args], { encoding: "utf8" });
  git("init", "--quiet");
  writeFileSync(join(source, "README.md"), "isolated fixture\n");
  git("add", "README.md");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "fixture");
  mkdirSync(join(f.cwd, "scripts"));
  writeFileSync(join(f.cwd, "scripts/setup-sdk.sh"), `SDK_REV="${git("rev-parse", "HEAD").trim()}"\n`);
  f.env.WORKFLOW_SDK_SOURCE = source;
  return source;
}

test("documented checks leave development data untouched and clean temporary catalogs", (t) => {
  for (const fail of [false, true]) {
    const f = fixture(t);
    f.env.WORKFLOW_CHECKS = "1";
    if (fail) f.env.WORKFLOW_FAIL_TEST = "1";
    mkdirSync(f.env.DACS_DIRECTORY_DATA);
    const seed = '[{"primaryClaim":"development-seed"}]\n';
    writeFileSync(join(f.env.DACS_DIRECTORY_DATA, "registrations.json"), seed);
    // Exercise a fresh development directory and a previously used catalog.
    const dbPath = join(f.env.DACS_DIRECTORY_DATA, "directory.sqlite");
    if (fail) {
      const db = new Database(dbPath);
      db.exec("CREATE TABLE developer_state (value TEXT); INSERT INTO developer_state VALUES ('preserve');");
      db.close();
    }
    const before = fail ? readFileSync(dbPath) : null;
    const run = f.run(`${checks}\nresult=$?\n[ "$DACS_DIRECTORY_DATA" = "$PWD/data" ] || exit 99\nexit "$result"`);
    assert.equal(run.status, fail ? 23 : 0, run.stderr);
    assert.deepEqual(readdirSync(f.env.DACS_DIRECTORY_DATA), fail ? ["directory.sqlite", "registrations.json"] : ["registrations.json"]);
    if (fail) assert.deepEqual(readFileSync(dbPath), before);
    assert.equal(readFileSync(join(f.env.DACS_DIRECTORY_DATA, "registrations.json"), "utf8"), seed);
    const commands = f.commands();
    assert.equal(commands.length, fail ? 2 : 4);
    for (const command of commands) {
      assert.equal(dirname(command.data), f.temporary);
      assert.notEqual(command.data, f.env.DACS_DIRECTORY_DATA);
      assert.equal(existsSync(command.data), false, "private catalog removed even on failure");
    }
    assert.deepEqual(readdirSync(f.temporary).filter((name) => name.startsWith("dacs-directory-checks.")), []);
  }
});

test("documented SDK install rejects redirected and shared checkouts before mutations", (t) => {
  for (const kind of [
    "vendor-symlink", "sdk-symlink", "dangling-symlink", "git-symlink", "linked-worktree",
    "objects-symlink", "objects-pack-symlink", "objects-fanout-symlink", "common-directory",
    "shared-objects", "http-alternates", "dangling-alternates", "shallow-symlink", "fetch-head-symlink", "dirty",
  ]) {
    const f = fixture(t);
    const source = sdkFixture(f);
    const vendor = join(f.cwd, "vendor");
    const sdk = join(vendor, "dacs-sdk");
    if (kind === "vendor-symlink") {
      const external = join(f.root, "external-vendor");
      mkdirSync(external);
      cpSync(source, join(external, "dacs-sdk"), { recursive: true });
      symlinkSync(external, vendor);
    } else {
      mkdirSync(vendor);
      if (kind === "sdk-symlink" || kind === "dangling-symlink") {
        symlinkSync(kind === "sdk-symlink" ? source : join(f.root, "missing"), sdk);
      } else if (kind === "linked-worktree") {
        execFileSync(realGit, ["-C", source, "worktree", "add", "--quiet", "--detach", sdk]);
      } else {
        cpSync(source, sdk, { recursive: true });
        if (kind === "git-symlink") {
          rmSync(join(sdk, ".git"), { recursive: true });
          symlinkSync(join(source, ".git"), join(sdk, ".git"));
        } else if (kind === "shared-objects") {
          writeFileSync(join(sdk, ".git/objects/info/alternates"), `${source}/.git/objects\n`);
        } else if (kind === "objects-symlink") {
          rmSync(join(sdk, ".git/objects"), { recursive: true });
          symlinkSync(join(source, ".git/objects"), join(sdk, ".git/objects"));
        } else if (kind === "objects-pack-symlink" || kind === "objects-fanout-symlink") {
          const entry = kind === "objects-pack-symlink" ? "pack" : readdirSync(join(source, ".git/objects")).find(name => /^[0-9a-f]{2}$/.test(name));
          assert.ok(entry, "fixture has loose objects");
          rmSync(join(sdk, ".git/objects", entry), { recursive: true });
          symlinkSync(join(source, ".git/objects", entry), join(sdk, ".git/objects", entry));
        } else if (kind === "common-directory") {
          writeFileSync(join(sdk, ".git/commondir"), `${source}/.git\n`);
        } else if (kind === "http-alternates") {
          writeFileSync(join(sdk, ".git/objects/info/http-alternates"), "https://example.invalid/objects\n");
        } else if (kind === "dangling-alternates") {
          symlinkSync(join(f.root, "missing"), join(sdk, ".git/objects/info/alternates"));
        } else if (kind === "shallow-symlink" || kind === "fetch-head-symlink") {
          const metadata = kind === "shallow-symlink" ? "shallow" : "FETCH_HEAD";
          rmSync(join(sdk, ".git", metadata), { force: true });
          symlinkSync(join(f.root, `external-${metadata}`), join(sdk, ".git", metadata));
        } else writeFileSync(join(sdk, "README.md"), "local edit\n");
      }
    }
    const before = snapshot(source);
    const run = f.run(install);
    assert.notEqual(run.status, 0, kind);
    assert.match(run.stderr, /stopped:/, kind);
    assert.deepEqual(f.commands(), [], `${kind}: no clone, fetch, checkout or npm`);
    assert.deepEqual(snapshot(source), before, `${kind}: external checkout and object store are unchanged`);
  }
});

test("documented SDK install accepts private clean clones and ignores Git path overrides", (t) => {
  for (const existing of [false, true]) {
    const f = fixture(t);
    const source = sdkFixture(f);
    if (existing) {
      mkdirSync(join(f.cwd, "vendor"));
      cpSync(source, join(f.cwd, "vendor/dacs-sdk"), { recursive: true });
    }
    Object.assign(f.env, {
      GIT_DIR: join(source, ".git"), GIT_WORK_TREE: source, GIT_COMMON_DIR: join(source, ".git"),
      GIT_INDEX_FILE: join(source, ".git/index"), GIT_SHALLOW_FILE: join(source, ".git/shallow"),
      GIT_OBJECT_DIRECTORY: join(source, ".git/objects"), GIT_ALTERNATE_OBJECT_DIRECTORIES: join(source, ".git/objects"),
    });
    const before = snapshot(source);
    // Path neutralization stays within the subshell, preserving the caller's Git setup.
    const run = f.run(`${install}\nresult=$?\n[ "$GIT_OBJECT_DIRECTORY" = "$WORKFLOW_SDK_SOURCE/.git/objects" ] || exit 99\nexit "$result"`);
    assert.equal(run.status, 0, run.stderr);
    const commands = f.commands();
    assert.equal(commands.filter((command) => command.tool === "git").length, existing ? 2 : 3);
    for (const command of commands.filter((command) => command.tool === "git")) {
      assert.deepEqual(command.gitPaths, {}, "Git mutations use checkout-local paths");
    }
    assert.deepEqual(snapshot(source), before, "external Git files are unchanged");
    assert.deepEqual(commands.filter((command) => command.tool === "npm").map((command) => command.args), [
      ["ci", "--no-audit", "--no-fund"], ["run", "build"], ["ci", "--no-audit", "--no-fund"],
    ]);
  }
});
