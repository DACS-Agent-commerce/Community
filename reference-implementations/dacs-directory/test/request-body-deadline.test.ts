import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { readRequestJson } from "../src/catalog/security.js";

const request = (body: ReadableStream<Uint8Array>) => new NextRequest("https://directory.test/api", {
  method: "POST", body, duplex: "half",
} as ConstructorParameters<typeof NextRequest>[1]);

// A fulfilled stream read resumes as a microtask before an overdue timer callback.
// Simulate a delayed producer using real elapsed time, without replacing the clock.
for (const lastRead of [false, true]) {
  test(`a body read that completes past its deadline is refused (done=${lastRead})`, async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        const until = performance.now() + 40;
        while (performance.now() < until) { /* delay the producer and timer queue */ }
        if (!lastRead) controller.enqueue(new TextEncoder().encode('{"ok":true}'));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const start = performance.now();
    const result = await readRequestJson(request(stream), 1024, 5);
    assert.ok(performance.now() - start >= 40);
    assert.equal(pulls, 1);
    assert.equal(result.ok, false, "an overdue successful read must not outrun the timeout callback");
    if (!result.ok) assert.equal(result.response.status, 408);
  });
}

test("an immediate body still succeeds before the deadline", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(c) {
    c.enqueue(new TextEncoder().encode('{"ok":true}')); c.close();
  } });
  assert.deepEqual(await readRequestJson(request(stream), 1024, 1000), { ok: true, value: { ok: true } });
});
