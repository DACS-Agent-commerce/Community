import assert from "node:assert/strict";
import test from "node:test";

import { contentHash } from "@kynesyslabs/dacs/canonical";
import { publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";

import {
  collectNativeStorageAddresses,
  readStorage,
  scanChain,
  storageReadFailureCode,
} from "../src/catalog/scan.js";

const native = `stor-${"a".repeat(40)}`;
const logical = `stor-${"b".repeat(64)}`;

const signerDid = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(Uint8Array.from(Buffer.alloc(32, 9))))).toString("hex")}`;
const owner = `0x${"1".repeat(64)}`;
const marker = {
  listingId: "svc",
  listingVersion: 1,
  listingContentHash: "c".repeat(64),
  revokedAt: 1_785_920_618_000,
  signature: { algorithm: "ed25519", signer: signerDid, value: "0".repeat(128) },
};
const binding = {
  bindingVersion: "1",
  jobId: "job-malformed",
  role: "buyer",
  logicalAddress: `stor-${"d".repeat(64)}`,
  nativeAddress: `stor-${"e".repeat(40)}`,
  bundleContentHash: "f".repeat(64),
  signer: signerDid,
  signature: { algorithm: "ed25519", signer: signerDid, value: "A".repeat(86) },
};
// JSON `1e400` parses to Infinity, which has no canonical (CF-1) number form.
const withInfinity = (value: Record<string, unknown>) => JSON.stringify(value).replace(/}$/, ',"futureField":1e400}');
const locatorOf = (digit: string) => `stor-${digit.repeat(40)}`;
const memo = (id: number, locator: string) =>
  ({ id, status: "confirmed", type: "transfer", hash: String(id).repeat(64).slice(0, 64), blockNumber: id, to: "0x1", content: JSON.stringify({ memo: locator }) });

/** Run one scan against a stubbed node: `storage` maps locator → raw `data` JSON text. */
async function scanFixture(transactions: unknown[], storage: Record<string, string>) {
  const originalFetch = globalThis.fetch;
  const originalDepth = process.env.DACS_SCAN_FINALITY_DEPTH;
  process.env.DACS_SCAN_FINALITY_DEPTH = "0";
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.startsWith("/storage-program/")) {
      const data = storage[path.slice("/storage-program/".length)];
      if (!data) return new Response(null, { status: 404 });
      return new Response(
        `{"success":true,"owner":"${owner}","programName":"opaque","data":${data}}`,
        { headers: { "content-type": "application/json" } },
      );
    }
    const call = JSON.parse(String(init?.body)).params?.[0];
    const response = call?.message === "getTransactions" && call.data?.start === "latest" ? transactions : null;
    return Response.json({ result: 200, response });
  };
  try {
    return await scanChain(null, { maxTxs: 100, sinceTxId: 0 });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDepth === undefined) delete process.env.DACS_SCAN_FINALITY_DEPTH;
    else process.env.DACS_SCAN_FINALITY_DEPTH = originalDepth;
  }
}

test("a storage artifact with no canonical form is observed unclassified and never stops the scan", async () => {
  const malformedMarker = locatorOf("2");
  const malformedBinding = locatorOf("3");
  const validMarker = locatorOf("4");
  const result = await scanFixture(
    [memo(3, malformedBinding), memo(2, malformedMarker), memo(1, validMarker)],
    {
      [malformedMarker]: withInfinity(marker),
      [malformedBinding]: withInfinity(binding),
      [validMarker]: JSON.stringify(marker),
    },
  );

  assert.equal(result.complete, true);
  assert.equal(result.scanError, undefined);
  const observed = new Map(result.observations.map((item) => [item.locator, item]));
  for (const locator of [malformedMarker, malformedBinding]) {
    assert.equal(observed.get(locator)?.kind, "other");
    assert.equal(observed.get(locator)?.contentHash, undefined);
  }
  assert.equal(observed.get(validMarker)?.kind, "listing-revocation");
  assert.equal(observed.get(validMarker)?.contentHash, contentHash(marker));
  assert.deepEqual(result.revocations.get(marker.listingContentHash), [validMarker]);
  assert.equal(result.bundleBindings.size, 0);
});

test("a storage write with no canonical form never stops the scan", async () => {
  const written = locatorOf("5");
  const validMarker = locatorOf("6");
  const write = {
    id: 2, status: "confirmed", type: "storageProgram", hash: "9".repeat(64), blockNumber: 2, to: written,
    content: `{"type":"storageProgram","to":"${written}","data":["storageProgram",{"operation":"WRITE_STORAGE","storageAddress":"${written}","data":${withInfinity(marker)}}]}`,
  };
  const result = await scanFixture([write, memo(1, validMarker)], { [validMarker]: JSON.stringify(marker) });

  assert.equal(result.complete, true);
  assert.equal(result.scanError, undefined);
  assert.equal(result.observations.find((item) => item.locator === validMarker)?.contentHash, contentHash(marker));
  assert.deepEqual(result.revocations.get(marker.listingContentHash), [validMarker]);
});

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
