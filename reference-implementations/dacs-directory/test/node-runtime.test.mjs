import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

// CI installs Node from .nvmrc. Railway's Railpack builder takes package.json
// engines.node, then lets mise's idiomatic version files (.nvmrc, .node-version,
// mise.toml, .tool-versions) override it. Production runs the .nvmrc release only
// while engines names that exact release and no other version file disagrees.
test("CI and Railway build on the exact .nvmrc Node release", () => {
  const release = read("../.nvmrc").trim();
  assert.match(release, /^22\.\d+\.\d+$/);

  assert.equal(JSON.parse(read("../package.json")).engines.node, release);
  assert.equal(JSON.parse(read("../package-lock.json")).packages[""].engines.node, release);
  for (const file of [".node-version", ".tool-versions", "mise.toml", ".mise.toml", "railpack.json"]) {
    assert.ok(!existsSync(new URL(`../${file}`, import.meta.url)), `${file} could select another Node release`);
  }

  const ci = read("../../../.github/workflows/dacs-directory-ci.yml");
  assert.match(ci, /^ +node-version-file: reference-implementations\/dacs-directory\/\.nvmrc$/m);
  assert.doesNotMatch(ci, /^ +node-version:/m);
  assert.equal(JSON.parse(read("../railway.json")).build.builder, "RAILPACK");
});
