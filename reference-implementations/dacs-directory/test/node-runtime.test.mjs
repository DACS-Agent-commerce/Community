import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkNodeRuntime } from "../scripts/check-node-runtime.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const appDir = fileURLToPath(new URL("..", import.meta.url));

// Version files Railpack v0.41.0 hands to mise
// (core/generate/mise_step_builder.go: miseConfigFiles, miseConfigGlobs, and the
// idiomatic .node-version), plus railpack.json. Any of them could select another
// Node release; .nvmrc is the one this app pins.
const OTHER_VERSION_FILES = [
  /^\.node-version$/,
  /^\.tool-versions$/,
  /^railpack\.json$/,
  /^\.?mise(\.[^/]+)?\.toml$/,
  /^\.?mise\/config(\.[^/]+)?\.toml$/,
  /^\.config\/mise(\.[^/]+)?\.toml$/,
  /^\.config\/mise\/(config|mise)(\.[^/]+)?\.toml$/,
  /^(\.?mise|\.config\/mise)\/conf\.d\/[^/]+\.toml$/,
];
const NOT_DEPLOYED = new Set(["node_modules", "vendor", ".next", "data", "test-results", "playwright-report"]);

function otherVersionFiles(root, dir = root, depth = 0) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 3 && !NOT_DEPLOYED.has(entry.name)) found.push(...otherVersionFiles(root, path, depth + 1));
    } else if (OTHER_VERSION_FILES.some((pattern) => pattern.test(relative(root, path)))) {
      found.push(relative(root, path));
    }
  }
  return found;
}

// CI installs Node from .nvmrc. Railway's Railpack builder takes package.json
// engines.node, then lets mise's version files override it, and Railway doesn't
// pin the Railpack release. So engines names the .nvmrc release, no other version
// file exists, and the build and server check the release they actually run.
test("CI and Railway build on the exact .nvmrc Node release", () => {
  const release = read("../.nvmrc").trim();
  assert.match(release, /^22\.\d+\.\d+$/);

  assert.equal(JSON.parse(read("../package.json")).engines.node, release);
  assert.equal(JSON.parse(read("../package-lock.json")).packages[""].engines.node, release);
  assert.deepEqual(otherVersionFiles(appDir), []);

  const ci = read("../../../.github/workflows/dacs-directory-ci.yml");
  assert.match(ci, /^ +node-version-file: reference-implementations\/dacs-directory\/\.nvmrc$/m);
  assert.doesNotMatch(ci, /^ +node-version:/m);
  assert.match(ci, /^ +run: npm run check:node-runtime$/m);
  const railway = JSON.parse(read("../railway.json"));
  assert.equal(railway.build.builder, "RAILPACK");
  assert.match(railway.build.buildCommand, /^npm run check:node-runtime && /);
  assert.equal(railway.deploy.startCommand, "npm run start:railway");
  const start = read("../scripts/start-railway.sh");
  assert.ok(
    start.indexOf("\nnode scripts/check-node-runtime.mjs\n") > 0
      && start.indexOf("\nnode scripts/check-node-runtime.mjs\n") < start.indexOf("next start"),
    "start-railway.sh must check the Node release before starting the server",
  );
  assert.equal(JSON.parse(read("../package.json")).scripts["check:node-runtime"], "node scripts/check-node-runtime.mjs");
});

test("the version-file guard sees every file Railpack's mise would read", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "node-runtime-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = [
    ".node-version", ".tool-versions", "railpack.json", "mise.toml", ".mise.toml", "mise.local.toml",
    ".mise.production.toml", "mise/config.toml", ".mise/config.toml", ".mise/config.local.toml",
    ".config/mise.toml", ".config/mise.local.toml", ".config/mise/config.toml", ".config/mise/mise.toml",
    ".config/mise/mise.local.toml", "mise/conf.d/node.toml", ".mise/conf.d/node.toml",
    ".config/mise/conf.d/node.toml",
  ];
  for (const file of [...files, ".nvmrc", "README.md", "node_modules/x/mise.toml"]) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), 'node = "24"\n');
  }
  assert.deepEqual(otherVersionFiles(dir).sort(), [...files].sort());
});

test("the Node runtime check fails unless the .nvmrc release runs", () => {
  const release = read("../.nvmrc").trim();
  assert.equal(checkNodeRuntime({ version: release }), `Node runtime matches .nvmrc: ${release}`);
  for (const version of ["22.23.2", "24.0.0", `${release}-pre`, ""]) {
    assert.throws(() => checkNodeRuntime({ version }), new RegExp(`^Error: Node ${version} is running, but \\.nvmrc pins ${release}`));
  }
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/check-node-runtime.mjs", import.meta.url))], {
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    encoding: "utf8",
  });
  if (process.versions.node === release) {
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout, `Node runtime matches .nvmrc: ${release}\n`);
  } else {
    assert.equal(cli.status, 1, cli.stdout);
    assert.match(cli.stderr, /^\[deployment config\] Node .* is running, but \.nvmrc pins/);
  }
});
