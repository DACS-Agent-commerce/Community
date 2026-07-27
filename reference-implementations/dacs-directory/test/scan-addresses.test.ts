import assert from "node:assert/strict";
import test from "node:test";

import { collectNativeStorageAddresses } from "../src/catalog/scan.js";

const native = `stor-${"a".repeat(40)}`;
const logical = `stor-${"b".repeat(64)}`;

test("scanner collects exact native locators without truncating logical bundle addresses", () => {
  const addresses = new Set<string>();
  collectNativeStorageAddresses({
    direct: native,
    nested: [`prefix ${native} suffix`, { logical }],
  }, addresses);

  assert.deepEqual([...addresses], [native]);
  assert.equal(addresses.has(logical.slice(0, "stor-".length + 40)), false);
});

test("scanner requires a hex boundary after the native locator", () => {
  const addresses = new Set<string>();
  collectNativeStorageAddresses([
    `${native}f`,
    `${native}-metadata`,
    `(${native})`,
  ], addresses);

  assert.deepEqual([...addresses], [native]);
});
