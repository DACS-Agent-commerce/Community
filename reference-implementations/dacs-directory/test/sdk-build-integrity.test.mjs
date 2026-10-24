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
