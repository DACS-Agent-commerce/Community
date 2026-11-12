import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const PINNED = "3904d704fb540e6e1d7dd502a0be29f20569c92d";
const COPIED_FROM = "9d820e0f0fea0d9d34c6c0a2b521c18badfb4fee";
const FIXTURES = ["sdk-client-directory-reader.ts", "kit-listing.ts"];

test("fixture headers name the pinned SDK and the revision the client rules were copied from", () => {
  const setup = readFileSync(new URL("../scripts/setup-sdk.sh", import.meta.url), "utf8");
  assert.equal(setup.match(/^SDK_REV="([0-9a-f]{40})"$/m)?.[1], PINNED);
  for (const name of FIXTURES) {
    const text = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
    const header = text.slice(0, text.indexOf("*/") + 2);
    assert.match(header, new RegExp(PINNED), name);
    assert.match(header, new RegExp(COPIED_FROM), name);
    assert.match(header, /absent at the pinned revision/, name);
    assert.match(header, /packages\/dacs-client/, name);
  }
});
