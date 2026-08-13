import assert from "node:assert/strict";
import test from "node:test";

import {
  collectNativeStorageAddresses,
  readStorage,
  storageReadFailureCode,
} from "../src/catalog/scan.js";

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

test("storage failures are classified into public-safe operational causes", () => {
  assert.equal(storageReadFailureCode(404), "STORAGE_NOT_FOUND");
  assert.equal(storageReadFailureCode(403), "STORAGE_NOT_PUBLIC");
  assert.equal(storageReadFailureCode(200, "PERMISSION_DENIED"), "STORAGE_NOT_PUBLIC");
  assert.equal(storageReadFailureCode(503), "STORAGE_RPC_UNAVAILABLE");
  assert.equal(storageReadFailureCode(503, "NOT_FOUND"), "STORAGE_RPC_UNAVAILABLE");
  assert.equal(storageReadFailureCode(200), "STORAGE_INVALID_RESPONSE");
});

test("terminal storage failures skip retries while transient failures remain bounded", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      return new Response(null, { status: 404 });
    };
    assert.deepEqual(await readStorage(native, 3), {
      success: false,
      failureCode: "STORAGE_NOT_FOUND",
    });
    assert.equal(calls, 1);

    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response("temporarily unavailable", { status: 503 });
    };
    assert.deepEqual(await readStorage(native, 2), {
      success: false,
      failureCode: "STORAGE_RPC_UNAVAILABLE",
    });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
