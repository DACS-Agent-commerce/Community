import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("README does not say the internal builder provides the finalized-receipt (LP-1) gate", () => {
  const row = readme.split("\n").find((line) => line.startsWith("| Seller publication |"));
  assert.ok(row, "the README has a Seller publication row");
  assert.doesNotMatch(row, /builder retains these gates/);
  assert.match(row, /builder checks rail authority \(LP-6\) and prepares a transaction/);
  assert.match(row, /does not satisfy LP-1/);
});

test("README requires rail authority (LP-6) only for pay-bearing listings", () => {
  const row = readme.split("\n").find((line) => line.startsWith("| Seller publication |"));
  assert.ok(row, "the README has a Seller publication row");
  assert.match(row, /for pay-bearing listings verified rail authority \(LP-6\)/);
  assert.doesNotMatch(row, /requires verified rail authority \(LP-6\)/);
});
