import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

const { GET } = await import("../app/api/dacs/artifact/route.js");
const ref = `stor-${"34".repeat(20)}`;
const request = () => new NextRequest(`http://localhost/api/dacs/artifact?ref=${ref}`);

async function withNodeAnswer(answer: () => Promise<Response>, run: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = answer;
  try { await run(); } finally { globalThis.fetch = realFetch; }
}

test("the artifact route answers 503 when the node cannot be reached", async () => {
  await withNodeAnswer(async () => { throw new TypeError("fetch failed"); }, async () => {
    const response = await GET(request());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "the node could not be read; the artifact is indeterminate", ref, status: "unavailable", value: null,
    });
  });
});

test("the artifact route answers 503 when the node fails", async () => {
  await withNodeAnswer(async () => new Response("bad gateway", { status: 502 }), async () => {
    assert.equal((await GET(request())).status, 503);
  });
});

test("the artifact route reports a node NOT_FOUND answer as absent", async () => {
  const notFound = JSON.stringify({ success: false, errorCode: "NOT_FOUND" });
  await withNodeAnswer(async () => new Response(notFound, { status: 404 }), async () => {
    const response = await GET(request());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ref, status: "absent", value: null });
  });
});

test("the artifact route reports non-object stored data as invalid", async () => {
  await withNodeAnswer(async () => Response.json({ success: true, data: "text" }), async () => {
    const response = await GET(request());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ref, status: "invalid", value: null });
  });
});

test("the artifact route returns the stored artifact as present", async () => {
  await withNodeAnswer(async () => Response.json({ success: true, data: { listingId: "saved-service" } }), async () => {
    const response = await GET(request());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ref, status: "present", value: { listingId: "saved-service" } });
  });
});
