import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const MAX_TIMEOUT_MINUTES = 60;

const ci = readFileSync(new URL("../../../.github/workflows/dacs-directory-ci.yml", import.meta.url), "utf8");

// The text of one top-level block, from its key to the next top-level key.
function topLevelBlock(key) {
  const block = ci.match(new RegExp(`^${key}:.*(?:\\n(?!\\S).*)*`, "m"));
  assert.ok(block, `the workflow has no top-level "${key}:" block`);
  return block[0];
}

test("the workflow token can only read repository contents", () => {
  const permissions = topLevelBlock("permissions");
  assert.match(permissions, /^ +contents: read$/m);
  assert.equal(permissions.trim().split("\n").length, 2, "permissions lists more than contents: read");
});

test("the verify job stops after a bounded number of minutes", () => {
  const verify = topLevelBlock("jobs").match(/^ {2}verify:\n(?:(?! {2}\S).*\n?)*/m);
  assert.ok(verify, "the verify job is missing");
  const minutes = Number(verify[0].match(/^ {4}timeout-minutes: (\d+)$/m)?.[1]);
  assert.ok(minutes >= 1 && minutes <= MAX_TIMEOUT_MINUTES, `timeout-minutes is ${minutes}`);
});
