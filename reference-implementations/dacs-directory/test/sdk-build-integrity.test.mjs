import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { distDigest, distManifest } from "../scripts/sdk-dist-digest.mjs";
const script = new URL("../scripts/setup-sdk.sh", import.meta.url);
const digestScript = new URL("../scripts/sdk-dist-digest.mjs", import.meta.url);
const compatOutputScript = new URL("../scripts/sdk-compat-output.mjs", import.meta.url);
const pinned = readFileSync(script, "utf8");
const builtIndex = "export {};\n";

// The fixture dist stands in for the pinned build: the copied script pins its digest.
const fixtureDist = mkdtempSync(join(tmpdir(), "dacs-setup-dist-"));
writeFileSync(join(fixtureDist, "index.js"), builtIndex);
const fixtureSha = distDigest(fixtureDist);
rmSync(fixtureDist, { recursive: true, force: true });

test("the digest CLI prints the digest from an app path with spaces, # or %, or through a symlink", () => {
  for (const name of ["app 1", "app#1", "app%1", "app%23", "linked app"]) {
    const scratch = mkdtempSync(join(tmpdir(), "dacs-digest-cli-"));
    const real = join(scratch, name === "linked app" ? "real app" : name);
    // The app is run through a symlinked path; Node loads the script from its real path.
    const root = join(scratch, name);
    try {
      mkdirSync(join(real, "scripts"), { recursive: true });
      mkdirSync(join(real, "dist"));
      writeFileSync(join(real, "dist/index.js"), builtIndex);
      copyFileSync(digestScript, join(real, "scripts/sdk-dist-digest.mjs"));
      if (root !== real) symlinkSync(real, root);
      const run = spawnSync(process.execPath, [join(root, "scripts/sdk-dist-digest.mjs"), join(root, "dist")], { encoding: "utf8" });
      assert.equal(run.status, 0, `${name}: ${run.stderr}`);
      assert.equal(run.stdout, `${fixtureSha}\n`, name);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});


test("the SDK compatibility patch bytes match their setup pin", () => {
  const expected = pinned.match(/^SDK_PATCH_SHA256="([0-9a-f]{64})"$/m)?.[1];
  const patch = readFileSync(new URL("../scripts/dacs-sdk-compat.patch", import.meta.url));
  assert.equal(createHash("sha256").update(patch).digest("hex"), expected);
});

test("setup pins the SDK revision that the compatibility patch is built against", () => {
  assert.equal(pinned.match(/^SDK_REV="([0-9a-f]{40})"$/m)?.[1], "3904d704fb540e6e1d7dd502a0be29f20569c92d");
});

function withDistTree(files, run) {
  const dist = mkdtempSync(join(tmpdir(), "dacs-dist-tree-"));
  try {
    for (const [name, contents] of Object.entries(files)) writeFileSync(join(dist, name), contents);
    return run(dist);
  } finally { rmSync(dist, { recursive: true, force: true }); }
}

// sha256("A") and sha256("B") as printed by `sha256sum`, and the sha256 of the two manifest lines below.
const manifestOfAAndB = "559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd  a\n"
  + "df7e70e5021544f4834bbee64a9e3789febc4be81470df629cad6ddb03320a5c  b\n";
const digestOfAAndB = "a9b02649b9d0ef200bc03602f5228c22e916ea31d41f4b5852acbd7845542d18";

test("the dist digest and manifest match a SHA-256 vector computed outside the helper", () => {
  withDistTree({ b: "B", a: "A" }, (dist) => {
    assert.equal(distManifest(dist), manifestOfAAndB);
    assert.equal(distDigest(dist), digestOfAAndB);
    const manifestFile = join(dist, "..", `${dist.split("/").pop()}.manifest`);
    const run = spawnSync(process.execPath, [fileURLToPath(digestScript), dist, "--manifest", manifestFile], { encoding: "utf8" });
    try {
      assert.equal(run.stdout, `${digestOfAAndB}\n`);
      assert.equal(readFileSync(manifestFile, "utf8"), manifestOfAAndB);
    } finally { rmSync(manifestFile, { force: true }); }
  });
});

test("the dist manifest sorts by path bytes and skips only setup's top-level marker files", () => {
  const dist = mkdtempSync(join(tmpdir(), "dacs-dist-order-"));
  try {
    mkdirSync(join(dist, "sub"));
    for (const name of ["a", "B", "é", ".dacs-sdk-built", "sub/.dacs-sdk-nested"]) writeFileSync(join(dist, name), name);
    const paths = distManifest(dist).trim().split("\n").map((line) => line.slice(66));
    assert.deepEqual(paths, ["B", "a", "sub/.dacs-sdk-nested", "é"]);
  } finally { rmSync(dist, { recursive: true, force: true }); }
});

test("the dist manifest refuses symlinks, empty trees and file names that could forge another manifest", () => {
  assert.throws(() => withDistTree({}, distManifest), /contains no files/);
  withDistTree({ a: "A" }, (dist) => {
    symlinkSync("a", join(dist, "link"));
    assert.throws(() => distManifest(dist), /link is not a regular file or directory/);
  });
  // One file named like two manifest lines must not hash the same as the two files a and b.
  withDistTree({ [`a\n${manifestOfAAndB.split("\n")[1]}`]: "A" }, (dist) => {
    assert.throws(() => distManifest(dist), /line break/);
  });
});

test("the digest CLI exits 2 on bad usage", () => {
  for (const args of [[], ["dist", "--bogus", "x"], ["dist", "--manifest"]]) {
    const run = spawnSync(process.execPath, [fileURLToPath(digestScript), ...args], { encoding: "utf8" });
    assert.equal(run.status, 2, args.join(" "));
  }
});

test("the compatibility output script writes type-stripped modules and drops source maps", () => {
  const sdk = mkdtempSync(join(tmpdir(), "dacs-compat-output-"));
  try {
    for (const module of ["artifacts/validators", "agent/verifyBundleCore"]) {
      mkdirSync(join(sdk, "src", dirname(module)), { recursive: true });
      mkdirSync(join(sdk, "dist", dirname(module)), { recursive: true });
      writeFileSync(join(sdk, `src/${module}.ts`), "export const value: number = 1;\n");
      writeFileSync(join(sdk, `dist/${module}.js`), "stale");
      writeFileSync(join(sdk, `dist/${module}.js.map`), "{}");
      writeFileSync(join(sdk, `dist/${module}.d.ts.map`), "{}");
      writeFileSync(join(sdk, `dist/${module}.d.ts`), "export declare const value: number;\n//# sourceMappingURL=x.d.ts.map\n");
    }
    const run = spawnSync(process.execPath, [fileURLToPath(compatOutputScript), sdk], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    for (const module of ["artifacts/validators", "agent/verifyBundleCore"]) {
      assert.equal(readFileSync(join(sdk, `dist/${module}.js`), "utf8"), "export const value = 1;\n");
      assert.equal(readFileSync(join(sdk, `dist/${module}.d.ts`), "utf8"), "export declare const value: number;\n");
      assert.equal(existsSync(join(sdk, `dist/${module}.js.map`)) || existsSync(join(sdk, `dist/${module}.d.ts.map`)), false);
    }
  } finally { rmSync(sdk, { recursive: true, force: true }); }
});
