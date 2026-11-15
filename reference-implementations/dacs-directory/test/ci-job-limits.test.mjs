import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const MAX_TIMEOUT_MINUTES = 60;

const ci = readFileSync(new URL("../../../.github/workflows/dacs-directory-ci.yml", import.meta.url), "utf8");

// The text of one top-level block, from its key to the next top-level key.
function topLevelBlock(key, workflow = ci) {
  // Comment indentation does not close a YAML mapping, including at column zero.
  const structuralText = workflow.replace(/^[ \t]*#.*$/gm, "");
  const block = structuralText.match(new RegExp(`^${key}:.*(?:\\n(?!\\S).*)*`, "m"));
  assert.ok(block, `the workflow has no top-level "${key}:" block`);
  return block[0];
}

function verifyJob(workflow = ci) {
  const verify = topLevelBlock("jobs", workflow).match(/^ {2}verify:\n(?:(?! {2}\S).*\n?)*/m);
  assert.ok(verify, "the verify job is missing");
  return verify[0];
}

function assertReadOnlyPermissions(workflow = ci) {
  const permissions = topLevelBlock("permissions", workflow);
  assert.match(permissions, /^ +contents: read$/m);
  assert.equal(permissions.trim().split("\n").length, 2, "permissions lists more than contents: read");
  assert.doesNotMatch(verifyJob(workflow), /^ {4}(?:permissions|"permissions"|'permissions')\s*:/m, "verify must inherit the workflow permissions");
}

test("the workflow token can only read repository contents", () => {
  assertReadOnlyPermissions();
});

test("the verify job stops after a bounded number of minutes", () => {
  const minutes = Number(verifyJob().match(/^ {4}timeout-minutes: (\d+)$/m)?.[1]);
  assert.ok(minutes >= 1 && minutes <= MAX_TIMEOUT_MINUTES, `timeout-minutes is ${minutes}`);
});

test("job permission overrides remain refused across comment-only lines", () => {
  for (const indentation of [0, 1, 2, 3, 4, 6]) {
    const comment = `${" ".repeat(indentation)}# a comment does not end a YAML job\n`;
    for (const key of ["permissions", "'permissions'", '"permissions"']) {
      const workflow = `permissions:\n  contents: read\njobs:\n${comment}  verify:\n    timeout-minutes: 30\n${comment}    ${key}: write-all\n  other:\n    runs-on: ubuntu-latest\n`;
      assert.throws(() => assertReadOnlyPermissions(workflow), /verify must inherit the workflow permissions/,
        `comment indent ${indentation}, key ${key}`);
    }
  }
});

test("comments, nested inputs and the next job do not create verify permission overrides", () => {
  for (const indentation of [0, 1, 2, 3, 4, 6]) {
    const comment = `${" ".repeat(indentation)}# permissions: write-all\n`;
    const workflow = `permissions:\n  contents: read\njobs:\n${comment}  verify:\n    timeout-minutes: 30\n${comment}    steps:\n      - uses: example/action@v1\n        with:\n          permissions: write-all\n  other:\n    permissions: write-all\n`;
    assert.doesNotThrow(() => assertReadOnlyPermissions(workflow), `comment indent ${indentation}`);
    assert.match(verifyJob(workflow), /^ {4}timeout-minutes: 30$/m);
    assert.doesNotMatch(verifyJob(workflow), /^ {2}other:/m);
  }
});
