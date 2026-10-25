import assert from "node:assert/strict";
import test from "node:test";
import {
  SAVED_ANCHOR_CHECK_TIMEOUT_MS, describeSavedAnchorCheck, readSavedAnchorStatus, savedAnchorAllowsDiscard, type SavedAnchorCheck,
} from "../src/components/saved-anchor-check.js";

const anchorAddress = `stor-${"34".repeat(20)}`;

async function readWith(answer: (url: string, init: RequestInit | undefined) => Promise<Response>): Promise<SavedAnchorCheck> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => answer(String(input), init);
  try { return await readSavedAnchorStatus(anchorAddress); } finally { globalThis.fetch = realFetch; }
}

test("the saved anchor read names the anchor and carries a deadline", async () => {
  let seen: { url: string; signal: AbortSignal | null | undefined } | undefined;
  await readWith(async (url, init) => {
    seen = { url, signal: init?.signal };
    return Response.json({ ref: anchorAddress, status: "absent", value: null });
  });
  assert.equal(seen?.url, `/api/dacs/artifact?ref=${anchorAddress}`);
  assert.ok(seen?.signal instanceof AbortSignal, "the read has an abort signal");
  assert.equal(SAVED_ANCHOR_CHECK_TIMEOUT_MS, 15_000);
});

test("the saved anchor read reports present, absent and invalid answers as they are", async () => {
  const present = await readWith(async () => Response.json({ ref: anchorAddress, status: "present", value: { listingId: "saved-service" } }));
  const absent = await readWith(async () => Response.json({ ref: anchorAddress, status: "absent", value: null }));
  const invalid = await readWith(async () => Response.json({ ref: anchorAddress, status: "invalid", value: null }));
  assert.deepEqual([present, absent, invalid], [{ status: "present" }, { status: "absent" }, { status: "invalid" }]);
});

test("the saved anchor read keeps a node outage apart from a missing artifact", async () => {
  const outage = await readWith(async () => Response.json({ ref: anchorAddress, status: "unavailable", value: null }, { status: 503 }));
  const unreachable = await readWith(async () => { throw new TypeError("fetch failed"); });
  assert.deepEqual(outage, { status: "unavailable", reason: "failed" });
  assert.deepEqual(unreachable, { status: "unavailable", reason: "failed" });
});

test("the saved anchor read reports a missed deadline as a timeout", async () => {
  const timedOut = await readWith(async () => { throw new DOMException("The operation timed out.", "TimeoutError"); });
  assert.deepEqual(timedOut, { status: "unavailable", reason: "timeout" });
});

test("the saved anchor read refuses a reply it cannot interpret", async () => {
  const replies: Array<() => Response> = [
    () => new Response("<html>", { status: 200 }),
    () => Response.json({ value: null }),
    () => Response.json({ status: "found", value: null }),
    () => Response.json({ status: "unavailable", value: null }),
    () => Response.json({ status: "present", value: null }),
    () => Response.json({ status: "present", value: [] }),
    () => Response.json({ status: "absent", value: { listingId: "saved-service" } }),
    () => Response.json(null),
  ];
  for (const reply of replies) {
    assert.deepEqual(await readWith(async () => reply()), { status: "unavailable", reason: "malformed" });
  }
});

test("each saved anchor check outcome has its own message", () => {
  const checks: SavedAnchorCheck[] = [
    { status: "present" }, { status: "absent" }, { status: "invalid" },
    { status: "unavailable", reason: "timeout" }, { status: "unavailable", reason: "failed" }, { status: "unavailable", reason: "malformed" },
  ];
  const messages = checks.map(describeSavedAnchorCheck);
  assert.equal(new Set(messages).size, checks.length);
  assert.match(messages[3]!, /timed out/);
});

test("discarding is offered only after a definitive saved anchor answer", () => {
  for (const status of ["present", "absent", "invalid"] as const) {
    assert.equal(savedAnchorAllowsDiscard({ status }), true, status);
  }
  for (const reason of ["timeout", "failed", "malformed"] as const) {
    assert.equal(savedAnchorAllowsDiscard({ status: "unavailable", reason }), false, reason);
  }
});
