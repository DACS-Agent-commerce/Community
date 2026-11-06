import assert from "node:assert/strict";
import test from "node:test";
import {
  VERIFY_DEAL_REQUEST_TIMEOUT_MS, VERIFY_DEAL_TIMEOUT_MESSAGE, VerifyDealTimeoutError, fetchArtifact, registeredBundleRefs,
} from "../src/components/verify-deal-requests.js";

async function withFetch<T>(answer: (url: string, init: RequestInit | undefined) => Promise<Response>, run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => answer(String(input), init);
  try { return await run(); } finally { globalThis.fetch = realFetch; }
}

const timeoutError = () => new DOMException("The operation timed out.", "TimeoutError");

test("the artifact request carries a deadline", async () => {
  let seen: { url: string; signal: AbortSignal | null | undefined } | undefined;
  const value = await withFetch(async (url, init) => {
    seen = { url, signal: init?.signal };
    return Response.json({ value: { listingId: "service" } });
  }, () => fetchArtifact("ref=stor-1"));
  assert.deepEqual(value, { listingId: "service" });
  assert.equal(seen?.url, "/api/dacs/artifact?ref=stor-1");
  assert.ok(seen?.signal instanceof AbortSignal, "the request has an abort signal");
  assert.equal(VERIFY_DEAL_REQUEST_TIMEOUT_MS, 15_000);
});

test("the deal-owners request names the deal and carries a deadline", async () => {
  let seen: { url: string; signal: AbortSignal | null | undefined } | undefined;
  const refs = await withFetch(async (url, init) => {
    seen = { url, signal: init?.signal };
    return Response.json({ owners: { buyer: "b", seller: "s" }, buyerBundleRef: "x", sellerBundleRef: "y" });
  }, () => registeredBundleRefs("job 1", "stor-2"));
  assert.deepEqual(refs, { owners: { buyer: "b", seller: "s" }, buyerBundleRef: "x", sellerBundleRef: "y" });
  assert.equal(seen?.url, "/api/dacs/deal-owners?jobId=job%201&bundleRef=stor-2");
  assert.ok(seen?.signal instanceof AbortSignal, "the request has an abort signal");
});

test("a stalled artifact request ends with a timeout error that names the cause", async () => {
  await withFetch(async () => { throw timeoutError(); }, async () => {
    await assert.rejects(fetchArtifact("ref=stor-1"), (error: unknown) => {
      assert.ok(error instanceof VerifyDealTimeoutError);
      assert.equal(error.message, VERIFY_DEAL_TIMEOUT_MESSAGE);
      return true;
    });
  });
});

test("a stalled deal-owners request is a timeout, not a missing registration", async () => {
  await withFetch(async () => { throw timeoutError(); }, async () => {
    await assert.rejects(registeredBundleRefs("job", "stor-2"), VerifyDealTimeoutError);
  });
});

test("both helpers reject with the timeout error when fetch receives an already-aborted deadline signal", async () => {
  const timeout = AbortSignal.timeout;
  // A signal whose deadline has already passed, as fetch sees it when a request stalls.
  AbortSignal.timeout = () => AbortSignal.abort(timeoutError());
  try {
    await withFetch(
      (_url, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason));
      }),
      async () => {
        await assert.rejects(fetchArtifact("ref=stor-1"), VerifyDealTimeoutError);
        await assert.rejects(registeredBundleRefs("job", "stor-2"), VerifyDealTimeoutError);
      },
    );
  } finally { AbortSignal.timeout = timeout; }
});

test("other failures keep their existing handling", async () => {
  await withFetch(async () => { throw new TypeError("fetch failed"); }, async () => {
    await assert.rejects(fetchArtifact("ref=stor-1"), TypeError);
    assert.equal(await registeredBundleRefs("job", "stor-2"), null, "an unreachable directory is no registration");
  });
  await withFetch(async () => new Response("no", { status: 503 }), async () => {
    assert.equal(await registeredBundleRefs("job", "stor-2"), null, "a refused request is no registration");
  });
  await withFetch(async () => Response.json({}), async () => {
    assert.equal(await fetchArtifact("ref=stor-1"), null, "a reply without a value is no artifact");
  });
});
