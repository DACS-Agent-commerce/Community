import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveAnchorAddress,
  deriveStorageAddress,
  LIVE_STORAGE_SALT,
  resolveOwnedAnchorByName,
} from "../src/catalog/chain.js";

const owner = `0x${"12".repeat(32)}`;
const programName = "dacs1-ZGFjczE";

test("live StorageProgram derivation matches SDK #70 and preserves legacy fallback", () => {
  assert.equal(
    deriveStorageAddress(owner, programName, 42, LIVE_STORAGE_SALT),
    "stor-225d925e0427753fdea2a5e5ac040d58e7c47ac3",
  );
  assert.equal(
    deriveAnchorAddress(owner, programName, 42),
    "stor-5fa6216130a97190c3b4e1bc2b66f4d3b8738fee",
  );
});

test("producer resume lookup binds an exact program name to exactly one owner", async () => {
  const honest = "stor-1111111111111111111111111111111111111111";
  const squatter = "stor-2222222222222222222222222222222222222222";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") {
      const request = JSON.parse(String(init.body)) as { params: Array<{ data: { options: Record<string, unknown> } }> };
      assert.deepEqual(request.params[0]?.data.options, { exactMatch: true, limit: 32, offset: 0 });
      return Response.json({
        result: 200,
        response: [
          { storageAddress: squatter, programName },
          { storageAddress: honest, programName },
          { storageAddress: "stor-3333333333333333333333333333333333333333", programName: `${programName}-suffix` },
        ],
      });
    }
    const address = String(input).split("/").at(-1);
    return Response.json({
      success: true,
      data: { listingId: "service" },
      owner: address === honest ? owner.toUpperCase() : `0x${"34".repeat(32)}`,
      programName,
    });
  };
  try {
    const resolution = await resolveOwnedAnchorByName(programName, owner);
    assert.equal(resolution.status, "present");
    if (resolution.status === "present") {
      assert.equal(resolution.address, honest);
      assert.equal(resolution.record.programName, programName);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("producer resume lookup fails closed on lookup, read, and duplicate ambiguity", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    assert.equal((await resolveOwnedAnchorByName(programName, owner)).status, "indeterminate");

    globalThis.fetch = async (_input, init) => init?.method === "POST"
      ? Response.json({ result: 200, response: [{ storageAddress: `stor-${"4".repeat(40)}`, programName }] })
      : new Response("unavailable", { status: 503 });
    assert.equal((await resolveOwnedAnchorByName(programName, owner)).status, "indeterminate");

    globalThis.fetch = async (input, init) => init?.method === "POST"
      ? Response.json({
          result: 200,
          response: [
            { storageAddress: `stor-${"5".repeat(40)}`, programName },
            { storageAddress: `stor-${"6".repeat(40)}`, programName },
          ],
        })
      : Response.json({ success: true, data: {}, owner, programName, ref: String(input) });
    const duplicate = await resolveOwnedAnchorByName(programName, owner);
    assert.equal(duplicate.status, "indeterminate");
    if (duplicate.status === "indeterminate") assert.match(duplicate.reason, /multiple owner-bound/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("producer resume lookup reports a proven absence", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ result: 200, response: [] });
  try {
    assert.deepEqual(await resolveOwnedAnchorByName(programName, owner), { status: "absent" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("producer resume lookup fails closed when the bounded result page is full", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    result: 200,
    response: Array.from({ length: 32 }, (_, index) => ({
      storageAddress: `stor-${index.toString(16).padStart(40, "0")}`,
      programName,
    })),
  });
  try {
    const resolution = await resolveOwnedAnchorByName(programName, owner);
    assert.equal(resolution.status, "indeterminate");
    if (resolution.status === "indeterminate") assert.match(resolution.reason, /candidate bound/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
