import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

const data = mkdtempSync(join(tmpdir(), "dacs-body-limits-"));
process.env.DACS_DIRECTORY_DATA = data;
process.env.DACS_ADMIN_TOKEN = "test";
const { POST } = await import("../app/api/dacs/index-now/route.js");
test.after(() => rmSync(data, { recursive: true, force: true }));

test("index-now refuses oversized chunked JSON without Content-Length before reading it all", async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new TextEncoder().encode(pulls === 1 ? '{"claim":"' : "x".repeat(16 * 1024)));
      if (pulls === 20) { controller.enqueue(new TextEncoder().encode('"}')); controller.close(); }
    },
    cancel() { cancelled = true; },
  });
  const req = new NextRequest("https://directory.test/api/dacs/index-now", {
    method: "POST", headers: { authorization: "Bearer test" }, body, duplex: "half",
  } as ConstructorParameters<typeof NextRequest>[1]);
  assert.equal(req.headers.has("content-length"), false);
  const response = await POST(req);
  assert.equal(response.status, 413);
  assert.ok(pulls < 20, "must stop before buffering the complete stream");
  assert.equal(cancelled, true);
});

const { readRequestJson } = await import("../src/catalog/security.js");
const request = (body: BodyInit | null, headers: Record<string, string> = {}) => new NextRequest(
  "https://directory.test/api", { method: "POST", body, headers, duplex: "half" } as ConstructorParameters<typeof NextRequest>[1],
);

for (const [route, limit] of [
  ["build-listing", 64 * 1024], ["confirm-listing", 64 * 1024],
  ["prepare-registration", 64 * 1024], ["register", 64 * 1024], ["register-domain", 4096],
] as const) {
  test(`${route} enforces its byte ceiling without a length header`, async () => {
    const { POST: handler } = await import(`../app/api/dacs/${route}/route.js`);
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(limit + 1)); c.close(); } });
    assert.equal((await handler(request(body))).status, 413);
  });
}

test("request JSON accepts the exact byte ceiling and counts UTF-8 bytes", async () => {
  const text = '"é"';
  assert.deepEqual(await readRequestJson(request(text), 4), { ok: true, value: "é" });
  const result = await readRequestJson(request(text), 3);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.response.status, 413);
});

test("received bytes override an understated length, with a length fast refusal", async () => {
  for (const length of ["1", "100"]) {
    const result = await readRequestJson(request('"abcdef"', { "content-length": length }), 4);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 413);
  }
});

test("empty and malformed JSON retain route validation behavior", async () => {
  assert.deepEqual(await readRequestJson(request(null)), { ok: true, value: null });
  assert.deepEqual(await readRequestJson(request("{")), { ok: true, value: null });
  assert.deepEqual(await readRequestJson(request('{"a":1}')), { ok: true, value: { a: 1 } });
});

test("request JSON matches Request.json BOM decoding across streamed bytes", async () => {
  const bytes = new TextEncoder().encode('\uFEFF{"claim":"é"}');
  const expected = await request(bytes).json();
  for (const split of [1, 2, 3, bytes.length]) {
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(bytes.slice(0, split)); c.enqueue(bytes.slice(split)); c.close(); },
    });
    assert.deepEqual(await readRequestJson(request(stream), bytes.length), { ok: true, value: expected });
  }
  const oversized = await readRequestJson(request(bytes), bytes.length - 1);
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.response.status, 413);
  // Use the base's native decoder as the oracle; repeated BOM handling is runtime-defined.
  for (const prefix of [0, 1, 2, 3, 4]) {
    const input = new TextEncoder().encode('\uFEFF'.repeat(prefix) + '{"claim":1}');
    const expected = await request(input).json().catch(() => null);
    assert.deepEqual(await readRequestJson(request(input)), { ok: true, value: expected }, `BOM count ${prefix}`);
  }
});

test("a stalled body times out even if cancellation never settles", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() { cancelled = true; return new Promise(() => {}); },
  });
  const result = await readRequestJson(request(stream), 100, 20);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.response.status, 408);
  assert.equal(cancelled, true);
});

test("stream read errors are a bounded client refusal", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.error(new Error("broken")); } });
  const result = await readRequestJson(request(stream));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.response.status, 400);
});
