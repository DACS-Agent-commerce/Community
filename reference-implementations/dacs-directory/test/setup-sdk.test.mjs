import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../scripts/setup-sdk.sh", import.meta.url);
const pinned = readFileSync(script, "utf8");
const sdkRev = pinned.match(/^SDK_REV="([0-9a-f]{40})"$/m)?.[1];
const standardRev = pinned.match(/^STANDARD_REV="([0-9a-f]{40})"$/m)?.[1];

/** Run setup against a packaged (no .git) vendor/dacs-sdk tree; never installs anything. */
function setupWithPackagedSdk({ marker, standardRevision }) {
  const root = mkdtempSync(join(tmpdir(), "dacs-setup-sdk-"));
  try {
    mkdirSync(join(root, "scripts"));
    copyFileSync(script, join(root, "scripts/setup-sdk.sh"));
    mkdirSync(join(root, "vendor/dacs-sdk/dist"), { recursive: true });
    writeFileSync(join(root, "vendor/dacs-sdk/dist/index.js"), "export {};\n");
    writeFileSync(join(root, "vendor/dacs-sdk/package.json"), JSON.stringify({ dacs: { standardRevision } }));
    if (marker !== undefined) writeFileSync(join(root, "vendor/dacs-sdk/dist/.dacs-sdk-revision"), marker);
    return spawnSync("bash", [join(root, "scripts/setup-sdk.sh")], {
      env: { ...process.env, DACS_SKIP_APP_INSTALL: "1" },
      encoding: "utf8",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("setup accepts a packaged SDK build only when it is marked as the pinned commit and Standard revision", () => {
  assert.match(sdkRev ?? "", /^[0-9a-f]{40}$/);
  assert.equal(standardRev, "d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20");
  const accepted = setupWithPackagedSdk({ marker: sdkRev, standardRevision: standardRev });
  assert.equal(accepted.status, 0, accepted.stderr);
  for (const [name, tree] of Object.entries({
    "unmarked prebuilt dist": { standardRevision: standardRev },
    "dist built from another commit": { marker: "0".repeat(40), standardRevision: standardRev },
    "SDK for another Standard revision": { marker: sdkRev, standardRevision: "4bb9e48a1095ab32c06c25b7c0b52018d3ce4091" },
  })) {
    const refused = setupWithPackagedSdk(tree);
    assert.notEqual(refused.status, 0, name);
    assert.doesNotMatch(refused.stdout, /setup complete/, name);
  }
});
