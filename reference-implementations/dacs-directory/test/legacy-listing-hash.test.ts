import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { legacyListingHash } from "../src/catalog/legacyListingHash.js";
import { registerLegacyListingHashCases } from "./fixtures/legacy-listing-hash-cases.js";

const digest = (preimage: string) => createHash("sha256").update(preimage, "utf8").digest("hex");

registerLegacyListingHashCases(test, assert, legacyListingHash, digest);

test("historical string values and keys have literal frozen preimages", () => {
  assert.equal(legacyListingHash({ value: "é" }), digest('{"value":"é"}'));
  assert.equal(legacyListingHash({ "é": "a/b é" }), digest('{"é":"a/b é"}'));
  assert.equal(legacyListingHash({ value: 'q"\\\b\f\n\r\t\u0000\u001f\u007f' }),
    digest('{"value":"q\\"\\\\\\b\\f\\n\\r\\t\\u0000\\u001f\u007f"}'));
  assert.equal(legacyListingHash({ flags: [true, false] }), digest('{"flags":[true,false]}'));
});

test("historical hash refuses lone surrogates and unsupported values", () => {
  assert.throws(() => legacyListingHash({ value: "\ud800" }), /lone surrogate/);
  assert.throws(() => legacyListingHash({ value: [undefined] }), /unsupported value type/);
  assert.throws(() => legacyListingHash({ value: 1n }), /unsupported value type/);
});

test("historical hash takes no string, escape or digest code from the pinned SDK", () => {
  const source = readFileSync(new URL("../src/catalog/legacyListingHash.ts", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import (.*) from "(.*)";$/gm)].map((match) => `${match[1]} from ${match[2]}`);
  assert.deepEqual(imports, ["{ createHash } from node:crypto", "{ assertValidUnicode } from ./canonical.js"]);
});
