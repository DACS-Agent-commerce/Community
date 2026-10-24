import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { distDigest } from "../scripts/sdk-dist-digest.mjs";

const script = new URL("../scripts/setup-sdk.sh", import.meta.url);
const digestScript = new URL("../scripts/sdk-dist-digest.mjs", import.meta.url);
const pinned = readFileSync(script, "utf8");
const sdkRev = pinned.match(/^SDK_REV="([0-9a-f]{40})"$/m)?.[1];
const standardRev = pinned.match(/^STANDARD_REV="([0-9a-f]{40})"$/m)?.[1];
const distSha = pinned.match(/^SDK_DIST_SHA256="([0-9a-f]{64})"$/m)?.[1];
const builtIndex = "export {};\n";

// The fixture dist stands in for the pinned build: the copied script pins its digest.
const fixtureDist = mkdtempSync(join(tmpdir(), "dacs-setup-dist-"));
writeFileSync(join(fixtureDist, "index.js"), builtIndex);
const fixtureSha = distDigest(fixtureDist);
rmSync(fixtureDist, { recursive: true, force: true });

/** Stub `git` and `npm`: the source path runs offline and records what it ran. */
function stubBin(root) {
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/usr/bin/env bash
echo "git $*" >> "$STUB_LOG"
case " $* " in
  *" rev-parse "*) printf '%s\\n' "$STUB_HEAD" ;;
  *" status "*) printf '%s' "\${STUB_STATUS:-}" ;;
esac
`);
  writeFileSync(join(bin, "npm"), `#!/usr/bin/env bash
echo "npm $*" >> "$STUB_LOG"
if [ "$1" = run ] && [ "$2" = build ]; then
  [ "\${STUB_BUILD_FAIL:-0}" = 1 ] && exit 1
  mkdir -p dist && printf '%s' "$STUB_BUILD_OUTPUT" > dist/index.js
fi
exit "\${STUB_NPM_EXIT:-0}"
`);
  chmodSync(join(bin, "git"), 0o755);
  chmodSync(join(bin, "npm"), 0o755);
  return bin;
}

/** Run setup in a scratch app root; never installs or fetches anything. */
function setup({ source = false, marker, standardRevision = standardRev, dist = { "index.js": builtIndex }, head = sdkRev, status = "",
  buildFail = false, buildOutput = builtIndex, link, stale, appInstall = false, npmExit = 0 }) {
  const root = mkdtempSync(join(tmpdir(), "dacs-setup-sdk-"));
  try {
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts/setup-sdk.sh"), pinned.replace(`SDK_DIST_SHA256="${distSha}"`, `SDK_DIST_SHA256="${fixtureSha}"`));
    copyFileSync(digestScript, join(root, "scripts/sdk-dist-digest.mjs"));
    writeFileSync(join(root, "scripts/sdk-compat-output.mjs"), "// The fixture compiler already emitted the fixture dist.\n");
    copyFileSync(new URL("../scripts/dacs-sdk-compat.patch", import.meta.url), join(root, "scripts/dacs-sdk-compat.patch"));
    const sdk = join(root, "vendor/dacs-sdk");
    mkdirSync(join(sdk, source ? ".git" : "dist"), { recursive: true });
    if (!source) for (const [name, content] of Object.entries(dist)) writeFileSync(join(sdk, "dist", name), content);
    if (link) symlinkSync(join(root, "outside.js"), join(sdk, "dist", link));
    if (stale) {
      mkdirSync(join(sdk, "dist"), { recursive: true });
      writeFileSync(join(sdk, "dist", stale), "export const removedSource = 1;\n");
    }
    writeFileSync(join(sdk, "package.json"), JSON.stringify({ dacs: { standardRevision } }));
    if (marker !== undefined) writeFileSync(join(sdk, ".dacs-sdk-revision"), marker);
    const log = join(root, "calls.log");
    writeFileSync(log, "");
    const result = spawnSync("bash", [join(root, "scripts/setup-sdk.sh")], {
      env: {
        ...process.env, DACS_SKIP_APP_INSTALL: appInstall ? "0" : "1", PATH: `${stubBin(root)}:${process.env.PATH}`, STUB_LOG: log,
        STUB_HEAD: head, STUB_STATUS: status, STUB_BUILD_FAIL: buildFail ? "1" : "0", STUB_BUILD_OUTPUT: buildOutput,
        STUB_NPM_EXIT: String(npmExit),
      },
      encoding: "utf8",
    });
    const read = (path) => existsSync(join(sdk, path)) ? readFileSync(join(sdk, path), "utf8") : undefined;
    return { ...result, calls: readFileSync(log, "utf8"), marker: read(".dacs-sdk-revision"), manifest: read(".dacs-sdk-manifest") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const refused = (run, name, reason) => {
  assert.notEqual(run.status, 0, name);
  assert.doesNotMatch(run.stdout, /setup complete/, name);
  if (reason) assert.match(run.stderr, reason, name);
};

test("setup pins the SDK commit, its Standard revision and the digest of its build", () => {
  assert.match(sdkRev ?? "", /^[0-9a-f]{40}$/);
  assert.equal(standardRev, "d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20");
  assert.match(distSha ?? "", /^[0-9a-f]{64}$/);
});

test("the pinned digest is the build of the vendored SDK", { skip: !existsSync(new URL("../vendor/dacs-sdk/dist", import.meta.url)) && "no vendored SDK build" }, () => {
  assert.equal(distDigest(new URL("../vendor/dacs-sdk/dist", import.meta.url).pathname), distSha);
});

test("setup accepts a packaged SDK build only with the pinned marker, Standard revision and bytes", () => {
  const accepted = setup({ marker: sdkRev });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.calls, "", "a packaged build runs no git or npm");
  for (const [name, tree, reason] of [
    ["unmarked prebuilt dist", {}, /not marked/],
    ["dist built from another commit", { marker: "0".repeat(40) }, /not marked/],
    ["SDK for another Standard revision", { marker: sdkRev, standardRevision: "4bb9e48a1095ab32c06c25b7c0b52018d3ce4091" }, /Standard revision/],
    ["marked dist with other bytes", { marker: sdkRev, dist: { "index.js": "export const injected = 1;\n" } }, /not the pinned build/],
    ["marked dist with an extra file", { marker: sdkRev, dist: { "index.js": builtIndex, "extra.js": "" } }, /not the pinned build/],
    ["marked dist with a dot-prefixed module", { marker: sdkRev, dist: { "index.js": builtIndex, ".dacs-sdk-hook.js": "" } }, /not the pinned build/],
    // A symlink would let bytes outside the hashed tree load as part of the SDK.
    ["marked dist with a symlink", { marker: sdkRev, link: "linked.js" }, /not a regular file/],
  ]) {
    refused(setup(tree), name, reason);
  }
});

test("packaged SDK setup enforces the app lockfile and propagates installation failure", () => {
  const installed = setup({ marker: sdkRev, appInstall: true });
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(installed.calls, "npm ci --no-audit --no-fund\n");
  const failed = setup({ marker: sdkRev, appInstall: true, npmExit: 23 });
  assert.equal(failed.status, 23);
  assert.doesNotMatch(failed.stdout, /setup complete/);
});

test("a source build is accepted only from a clean pinned checkout whose output is the pinned build", () => {
  const built = setup({ source: true });
  assert.equal(built.status, 0, built.stderr);
  assert.match(built.calls, /npm ci/);
  assert.equal(built.marker, sdkRev, "the source build marks its own output");
  assert.match(built.manifest ?? "", /^[0-9a-f]{64} {2}index\.js\n$/, "and records the per-file manifest it pinned");

  for (const [name, options, reason] of [
    ["checkout at another commit", { head: "1".repeat(40) }, /not a clean checkout/],
    ["checkout with local changes", { status: " M src/index.ts\n" }, /not a clean checkout/],
    ["SDK for another Standard revision", { standardRevision: "4bb9e48a1095ab32c06c25b7c0b52018d3ce4091" }, /Standard revision/],
  ]) {
    const run = setup({ source: true, ...options });
    refused(run, name, reason);
    assert.doesNotMatch(run.calls, /npm/, `${name}: nothing is built`);
    assert.equal(run.marker, undefined, name);
  }

  // A stale marker never survives a failed or divergent rebuild.
  const failed = setup({ source: true, marker: sdkRev, buildFail: true });
  refused(failed, "failed build");
  assert.equal(failed.marker, undefined, "the old marker is cleared before building");
  const divergent = setup({ source: true, marker: sdkRev, buildOutput: "export const other = 1;\n" });
  refused(divergent, "build output that is not the pinned build", /not the pinned build/);
  assert.equal(divergent.marker, undefined);

  // Output an earlier SDK_REV left behind is not part of this build.
  const rebuilt = setup({ source: true, stale: "removed.js" });
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.match(rebuilt.manifest ?? "", /^[0-9a-f]{64} {2}index\.js\n$/);
});

