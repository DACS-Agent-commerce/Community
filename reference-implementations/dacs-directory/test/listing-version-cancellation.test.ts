import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { beforeEach } from "node:test";
import { NextRequest } from "next/server";
import type { ListingSummary } from "../src/catalog/types.js";

process.env.DEMOS_RPC = "https://node.test";
const store = await import("../src/catalog/store.js");
const { GET } = await import("../app/api/dacs/listings/[listingId]/[version]/route.js");

// Reuse public signed bytes; the route's successful control performs real verification.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/listing-public-storage.json", import.meta.url), "utf8")) as {
  contentHash: string;
  listing: {
    listingId: string; listingVersion: number;
    seller: { displayName: string; identity: { presentedBy: string } };
    offering: ListingSummary["offering"];
  };
};
const locator = `stor-${"6".repeat(40)}`;
const summary: ListingSummary = {
  listingId: fixture.listing.listingId, version: fixture.listing.listingVersion,
  contentHash: fixture.contentHash, anchor: { kind: "storage-program", locator },
  seller: { primaryClaim: fixture.listing.seller.identity.presentedBy, displayName: fixture.listing.seller.displayName },
  artifactProfile: "dacs-v0.1", offering: fixture.listing.offering,
  pricing: { kind: "fixed" }, status: "active", catalogObservedAt: 1,
};
const storageReply = () => Response.json({ success: true, data: fixture.listing });
const params = () => ({ params: Promise.resolve({ listingId: summary.listingId, version: String(summary.version) }) });
const request = (signal?: AbortSignal) => new NextRequest(
  `https://directory.test/api/dacs/listings/${summary.listingId}/${summary.version}`, { signal },
);

beforeEach(() => {
  store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [{
    primaryClaim: summary.seller.primaryClaim, displayName: summary.seller.displayName,
    cci: [], listings: [summary], deals: [], registeredAt: 1, lastIndexedAt: 1,
    reputation: { completed: 0, totalAgreements: 0, completionRate: null },
  }] });
});

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      // A watchdog only: progression uses handshakes, never sleeps or the real 15 s timeout.
      timer = setTimeout(() => reject(new Error(label)), 3_000);
    })]);
  } finally { clearTimeout(timer); }
}

function pendingAnchorRead() {
  let started!: () => void, cancelled!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const cancelledPromise = new Promise<void>((resolve) => { cancelled = resolve; });
  let release = () => {}, calls = 0, cancellations = 0;
  const fetch: typeof globalThis.fetch = (input, init) => {
    assert.equal(String(input), `https://node.test/storage-program/${locator}`);
    calls++;
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal, "the underlying read must retain its timeout signal");
      const abort = () => {
        signal.removeEventListener("abort", abort);
        cancellations++;
        cancelled();
        reject(signal.reason);
      };
      release = () => { signal.removeEventListener("abort", abort); resolve(storageReply()); };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      started();
    });
  };
  return {
    fetch, started: startedPromise, cancelled: cancelledPromise, release: () => release(),
    get calls() { return calls; }, get cancellations() { return cancellations; },
  };
}

async function withPendingRead(req: NextRequest, check: (
  read: ReturnType<typeof pendingAnchorRead>, response: Promise<Response>,
) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const read = pendingAnchorRead();
  globalThis.fetch = read.fetch;
  const response = GET(req, params());
  try { await check(read, response); }
  finally {
    // Release even a broken, non-cancelling read before restoring the mock.
    read.release();
    try { await bounded(response, "the route did not settle during cleanup"); }
    finally { globalThis.fetch = originalFetch; }
  }
}

async function assertUnavailable(response: Promise<Response>) {
  const result = await bounded(response, "the route did not classify the cancelled read");
  assert.equal(result.status, 503);
  assert.deepEqual(await result.json(), {
    error: "listing anchor unavailable: the Demos node could not be read",
    reason: "anchor read timed out",
  });
}

test("aborting a pending listing-version request cancels its underlying anchor read", async () => {
  const controller = new AbortController();
  await withPendingRead(request(controller.signal), async (read, response) => {
    await bounded(read.started, "the underlying anchor read did not start");
    controller.abort();
    await bounded(read.cancelled, "request cancellation did not reach the pending underlying read");
    await assertUnavailable(response);
    assert.equal(read.calls, 1);
    assert.equal(read.cancellations, 1);
  });
});

test("an already-aborted listing-version request rejects at the underlying read boundary", async () => {
  const controller = new AbortController();
  controller.abort();
  await withPendingRead(request(controller.signal), async (read, response) => {
    await bounded(read.started, "the underlying anchor read boundary was not reached");
    await bounded(read.cancelled, "the underlying read ignored an already-aborted request");
    await assertUnavailable(response);
    assert.equal(read.calls, 1);
    assert.equal(read.cancellations, 1);
  });
});

test("a non-aborted listing-version request reads and verifies the signed Listing", async () => {
  const controller = new AbortController();
  await withPendingRead(request(controller.signal), async (read, response) => {
    await bounded(read.started, "the successful underlying read did not start");
    read.release();
    const result = await bounded(response, "the successful route did not settle");
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), fixture.listing);
    assert.equal(controller.signal.aborted, false);
    assert.equal(read.calls, 1);
    assert.equal(read.cancellations, 0);
  });
});

test("the independent 15 s anchor timeout still cancels a non-aborted request", async () => {
  const originalTimeout = AbortSignal.timeout;
  const timeout = new AbortController(), controller = new AbortController();
  const requestedTimeouts: number[] = [];
  AbortSignal.timeout = (milliseconds) => { requestedTimeouts.push(milliseconds); return timeout.signal; };
  try {
    await withPendingRead(request(controller.signal), async (read, response) => {
      await bounded(read.started, "the timed underlying read did not start");
      timeout.abort(new DOMException("test deadline", "TimeoutError"));
      await bounded(read.cancelled, "the independent timeout did not cancel the pending read");
      await assertUnavailable(response);
      assert.equal(controller.signal.aborted, false);
      assert.equal(read.cancellations, 1);
      assert.deepEqual(requestedTimeouts, [15_000]);
    });
  } finally { AbortSignal.timeout = originalTimeout; }
});

for (const [name, reply, expected] of [
  ["node outage", () => new Response(null, { status: 503 }), { status: 503, body: {
    error: "listing anchor unavailable: the Demos node could not be read", reason: "anchor read refused HTTP 503",
  } }],
  ["invalid stored content", () => Response.json({ success: true, data: null }), { status: 502, body: {
    error: "listing anchor failed verification",
  } }],
] as const) {
  test(`listing-version ${name} retains its response classification`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => reply();
    try {
      const response = await bounded(GET(request(), params()), "the route did not classify the read failure");
      assert.equal(response.status, expected.status);
      assert.deepEqual(await response.json(), expected.body);
    } finally { globalThis.fetch = originalFetch; }
  });
}
