import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveAnchorAddress,
  deriveStorageAddress,
  LIVE_STORAGE_SALT,
  readAnchorResult,
  readArtifact,
  readPayloadRecord,
  resolveOwnedAnchorByName,
  UNKNOWN_NODE_CALL,
  isUnknownNodeCall,
} from "../src/catalog/chain.js";
import { VerificationUnavailable } from "../src/catalog/verificationUnavailable.js";

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

test("producer resume lookup uses the pinned node's gcr_routine search when the node does not know the nodeCall", async () => {
  const honest = "stor-1111111111111111111111111111111111111111";
  const originalFetch = globalThis.fetch;
  const calls: Array<{ method: string; params: unknown; identity: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") {
      const request = JSON.parse(String(init.body)) as { method: string; params: Array<Record<string, unknown>> };
      calls.push({ method: request.method, params: request.params[0], identity: new Headers(init.headers).get("identity") });
      // kynesyslabs/node ac8f45f: an unknown nodeCall message is result 200 with this literal.
      if (request.method === "nodeCall") return Response.json({ result: 200, response: '{ error: "Unknown message"}', require_reply: false, extra: null });
      // Pinned middleware verifies any supplied signature and returns 401 for
      // the SDK helper's incompatible digest. Public gcr_routine needs none.
      if (new Headers(init.headers).has("identity")) return Response.json({ error: "invalid signature" }, { status: 401 });
      assert.deepEqual([...new Headers(init.headers)], [["content-type", "application/json"]]);
      return Response.json({ result: 200, response: [{ storageAddress: honest, programName }] });
    }
    return Response.json({ success: true, data: { listingId: "service" }, owner, programName });
  };
  try {
    const resolution = await resolveOwnedAnchorByName(programName, owner);
    assert.equal(resolution.status, "present");
    assert.deepEqual(calls.map((call) => call.method), ["nodeCall", "gcr_routine"]);
    assert.deepEqual(calls[1].params, { method: "searchStoragePrograms", params: [programName, { exactMatch: true, limit: 32, offset: 0 }] });
    assert.equal(calls[1].identity, null, "public search must not send incompatible authentication");
    // Any other non-list answer is not the pinned node's unknown-message reply: no fallback, indeterminate.
    calls.length = 0;
    globalThis.fetch = async (_input, init) => {
      calls.push({ method: JSON.parse(String(init?.body)).method, params: null, identity: null });
      return Response.json({ result: 200, response: "{ error: \"Rate limited\"}" });
    };
    assert.equal((await resolveOwnedAnchorByName(programName, owner)).status, "indeterminate");
    assert.deepEqual(calls.map((call) => call.method), ["nodeCall"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the read-only node contract probe compares both search paths and the storage not-found answer", async () => {
  const { probeNodeContract } = await import("../src/catalog/nodeContract.js");
  const originalFetch = globalThis.fetch;
  const node = (nodeCall: unknown, gcr: unknown, notFound = Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 }),
    knownProgram = Response.json({ success: true, programName, owner, data: {} })) =>
    async (input: unknown, init?: RequestInit) => {
      assert.ok(init?.signal, "every read has a deadline");
      if (init?.method !== "POST") return String(input).endsWith(`stor-${"0".repeat(40)}`)
        ? notFound.clone() : knownProgram.clone();
      if (new Headers(init.headers).has("identity")) return Response.json({ error: "invalid signature" }, { status: 401 });
      assert.deepEqual([...new Headers(init.headers)], [["content-type", "application/json"]]);
      return Response.json(JSON.parse(String(init.body)).method === "nodeCall" ? nodeCall : gcr);
    };
  const found = { result: 200, response: [{ storageAddress: `stor-${"1".repeat(40)}`, programName }] };
  try {
    const verdict = async (fetcher: ReturnType<typeof node>) => {
      globalThis.fetch = fetcher as typeof fetch;
      const { rpc: _, observedAt: __, ...report } = await probeNodeContract("https://node.example/", programName);
      return report;
    };
    assert.deepEqual(await verdict(node(found, found)),
      { storageNotFound: true, nodeCallSearch: "supported", gcrRoutineSearch: "supported", searchesAgree: true, ok: true });
    assert.deepEqual(await verdict(node({ result: 200, response: UNKNOWN_NODE_CALL }, found)),
      { storageNotFound: true, nodeCallSearch: "unknown-message", gcrRoutineSearch: "supported", searchesAgree: null, ok: true }, "the pinned revision");
    assert.equal((await verdict(node(found, { result: 200, response: [] }))).ok, false, "the two paths disagree");
    for (const entry of [{}, null, [], { storageAddress: 7, programName },
      { storageAddress: `stor-${"1".repeat(40)}` },
      { storageAddress: `stor-${"1".repeat(40)}`, programName: `${programName}-suffix` },
      { storageAddress: `prefix-stor-${"1".repeat(40)}`, programName }]) {
      const malformed = { result: 200, response: [entry] };
      assert.deepEqual(await verdict(node(malformed, malformed)),
        { storageNotFound: true, nodeCallSearch: "failed", gcrRoutineSearch: "failed", searchesAgree: null, ok: false },
        `malformed search entry ${JSON.stringify(entry)}`);
    }
    assert.equal((await verdict(node({ result: 200, response: [{}] }, found))).ok, false,
      "a malformed nodeCall must not select a fallback the Directory would never use");
    assert.deepEqual(await verdict(node({ result: 200, response: [] }, { result: 200, response: [] })),
      { storageNotFound: true, nodeCallSearch: "supported", gcrRoutineSearch: "supported", searchesAgree: true, ok: false }, "an empty search cannot certify a known public program");
    assert.equal((await verdict(node({ result: 200, response: UNKNOWN_NODE_CALL }, { result: 200, response: [] }))).ok, false,
      "an empty fallback also cannot certify a known program");
    for (const known of [
      Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 }),
      Response.json({ success: true, programName: `${programName}-wrong`, owner, data: {} }),
      Response.json({ success: true, programName, data: {} }),
      Response.json({ success: true, programName, owner, data: [] }),
      new Response("{", { status: 200 }),
    ]) assert.equal((await verdict(node(found, found, undefined, known))).ok, false, "matching searches still need a fresh public storage read");
    for (const length of [31, 32, 33]) {
      const page = { result: 200, response: Array.from({ length }, (_, index) => ({
        storageAddress: `stor-${(index + 1).toString(16).padStart(40, "0")}`, programName,
      })) };
      const expected = length < 32;
      const report = await verdict(node(page, page));
      assert.equal(report.ok, expected, `both search pages contain ${length} candidates`);
      assert.equal(report.nodeCallSearch, expected ? "supported" : "failed");
      assert.equal(report.gcrRoutineSearch, expected ? "supported" : "failed");
      assert.equal((await verdict(node({ result: 200, response: UNKNOWN_NODE_CALL }, page))).ok, expected,
        `fallback page contains ${length} candidates`);
      assert.equal((await verdict(node(page, found))).ok, false, "one full or disagreeing page cannot pass");
      assert.equal((await verdict(node(found, page))).ok, false, "a short direct page cannot hide a full or disagreeing GCR page");
    }
    for (const invalidGcr of [null, { result: 503 }, { result: 200, response: [{}] }]) {
      assert.equal((await verdict(node(found, invalidGcr))).ok, false, 'direct success cannot hide an indeterminate GCR comparison');
    }
    assert.equal((await verdict(node(found, found, new Response(null, { status: 404 })))).ok, false, "a bare 404 is not the node's answer");
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
      storageAddress: `stor-${(index + 1).toString(16).padStart(40, "0")}`,
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

test("a storage read separates a definitive answer from a transport failure (RB-6)", async () => {
  const at = "stor-4444444444444444444444444444444444444444";
  const body = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const nodeError = (status: number, errorCode: string) => body({ success: false, error: "storage program read failed", errorCode }, status);
  // An unavailable read keeps its cause: `denied` and `too-large` are the program as its owner keeps it,
  // the others are no answer at all.
  const deep = (levels: number): unknown => levels === 0 ? 1 : { next: deep(levels - 1) };
  const cases: Array<[string, () => Response | Promise<Response>, string, string?]> = [
    ["object data", () => body({ success: true, owner, programName, data: { marker: 1 } }), "present"],
    // The node's own answers are definitive.
    ["not found", () => nodeError(404, "NOT_FOUND"), "absent"],
    ["not public", () => nodeError(403, "PERMISSION_DENIED"), "unavailable", "denied"],
    // A 4xx without the node's matching errorCode is a proxy, a route or a mismatch: incomplete (RB-6).
    ["a body-less 404", () => new Response(null, { status: 404 }), "unavailable", "node-error"],
    ["a proxy's 404", () => body({ error: "Not Found" }, 404), "unavailable", "node-error"],
    ["a body-less 403", () => new Response(null, { status: 403 }), "unavailable", "node-error"],
    ["a 404 naming another error", () => nodeError(404, "PERMISSION_DENIED"), "unavailable", "node-error"],
    ["a 403 naming another error", () => nodeError(403, "NOT_FOUND"), "unavailable", "node-error"],
    ["a 404 reporting success", () => body({ success: true, errorCode: "NOT_FOUND" }, 404), "unavailable", "node-error"],
    ["a 403 reporting success", () => body({ success: true, errorCode: "PERMISSION_DENIED" }, 403), "unavailable", "node-error"],
    ["unauthenticated", () => new Response(null, { status: 401 }), "unavailable", "node-error"],
    ["invalid request", () => new Response(null, { status: 400 }), "unavailable", "node-error"],
    ["the node's invalid request", () => nodeError(400, "INVALID_REQUEST"), "unavailable", "node-error"],
    ["non-object data", () => body({ success: true, owner, programName, data: "text" }), "invalid"],
    ["oversized response", () => new Response("x".repeat(1024 * 1024 + 1)), "unavailable", "too-large"],
    ["data over the artifact bound", () => body({ success: true, owner, programName, data: { text: "x".repeat(256 * 1024) } }), "unavailable", "too-large"],
    ["data over the depth bound", () => body({ success: true, owner, programName, data: deep(130) }), "unavailable", "too-large"],
    ["node failure", () => new Response(null, { status: 503 }), "unavailable", "node-error"],
    ["failed HTTP with plausible success JSON", () => body({ success: true, owner, programName, data: {} }, 503), "unavailable", "node-error"],
    ["rate limited", () => new Response(null, { status: 429 }), "unavailable", "node-error"],
    ["unsuccessful body", () => body({ success: false }), "unavailable", "node-error"],
    ["truncated JSON", () => new Response("{\"success\":tr"), "unavailable", "node-error"],
    ["network error", () => { throw new TypeError("fetch failed"); }, "unavailable", "transport"],
    ["timeout", () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }, "unavailable", "timeout"],
  ];
  const originalFetch = globalThis.fetch;
  try {
    for (const [name, respond, expected, cause] of cases) {
      globalThis.fetch = async () => respond();
      const read = await readAnchorResult(at);
      assert.equal(read.status, expected, name);
      assert.equal(read.status === "unavailable" ? read.cause : undefined, cause, name);
    }
    assert.equal((await readAnchorResult("stor-../../admin")).status, "absent");
  } finally {
    globalThis.fetch = originalFetch;
  }
});


// DACS-5 §10.5.1: the evidence graph refutes a session only on an answer. A record its owner keeps
// unreadable here (denied, over the bounds) refutes only the session citing it, as deleting it would;
// no answer leaves that session undecided (VerificationUnavailable), and so does a payload closed to
// this anonymous reader, since DV-2 lets a public listing be delivered privately.
test("the graph's artifact and payload readers refute only on an answer", async () => {
  const at = `stor-${"5".repeat(40)}`;
  const body = (value: unknown, status = 200) => Response.json(value, { status });
  const data = { marker: 1 };
  const replies: Array<[string, () => Response, "data" | "null" | "throws", "data" | "null" | "throws"]> = [
    ["present", () => body({ success: true, owner, programName, data, acl: { mode: "public" } }), "data", "data"],
    ["absent", () => body({ success: false, errorCode: "NOT_FOUND" }, 404), "null", "null"],
    ["invalid", () => body({ success: true, owner, programName, data: "text" }), "null", "null"],
    ["denied", () => body({ success: false, errorCode: "PERMISSION_DENIED" }, 403), "null", "throws"],
    ["too large", () => body({ success: true, owner, programName, data: { text: "x".repeat(256 * 1024) } }), "null", "null"],
    ["a node error", () => new Response(null, { status: 503 }), "throws", "throws"],
    ["a transport failure", () => { throw new TypeError("fetch failed"); }, "throws", "throws"],
  ];
  const outcome = async (read: () => Promise<unknown>) => {
    try { const value = await read(); return value === null ? "null" : "data"; } catch (error) {
      assert.ok(error instanceof VerificationUnavailable, String(error));
      return "throws";
    }
  };
  const originalFetch = globalThis.fetch;
  try {
    for (const [name, respond, artifact, payload] of replies) {
      globalThis.fetch = async () => respond();
      assert.equal(await outcome(() => readArtifact(at)), artifact, `artifact: ${name}`);
      assert.equal(await outcome(() => readPayloadRecord(at)), payload, `payload: ${name}`);
    }
    globalThis.fetch = async () => body({ success: true, owner, programName, data, acl: { mode: "public" } });
    assert.deepEqual(await readArtifact(at), data);
    assert.deepEqual((await readPayloadRecord(at))?.acl, { mode: "public" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("storage reads retain node ACL separately from payload assertions", async () => {
  const originalFetch = globalThis.fetch;
  const acl = { mode: "restricted", allowed: [owner] };
  const data = { acl: { mode: "public" }, report: "cleartext" };
  globalThis.fetch = async () => Response.json({ success: true, owner, programName, data, acl });
  try {
    const read = await readAnchorResult(`stor-${"7".repeat(40)}`);
    assert.equal(read.status, "present");
    if (read.status === "present") {
      assert.deepEqual(read.record.acl, acl);
      assert.deepEqual(read.record.data, data);
    }
  } finally { globalThis.fetch = originalFetch; }
});


test("node2 2026-10-17 structured unknown-message reply is recognized precisely", async () => {
  assert.equal(UNKNOWN_NODE_CALL, '{ error: "Unknown message"}');
  assert.equal(isUnknownNodeCall({ result: 200, response: '{ error: "Unknown message"}' }), true);
  assert.equal(isUnknownNodeCall({ result: 404, response: { error: "Unknown message", message: "searchStoragePrograms" } }), true);
  assert.equal(isUnknownNodeCall({ result: 404, response: { error: "Rate limited" } }), false);
  assert.equal(isUnknownNodeCall({ result: 500, response: { error: "Unknown message" } }), false);
  const original = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "POST") {
      const call = JSON.parse(String(init.body)); methods.push(call.method);
      return call.method === "nodeCall" ? Response.json({ result: 404, response: { error: "Unknown message" } })
        : Response.json({ result: 200, response: [] });
    }
    throw new Error("unexpected storage read");
  };
  try {
    assert.equal((await resolveOwnedAnchorByName(programName, owner)).status, "indeterminate");
    assert.deepEqual(methods, ["nodeCall", "gcr_routine"]);
  } finally { globalThis.fetch = original; }
});

test("node deployment probe refuses failed HTTP even with a plausible successful public program", async () => {
  const { probeNodeContract } = await import("../src/catalog/nodeContract.js");
  const original = globalThis.fetch;
  const at = `stor-${"8".repeat(40)}`;
  let readStatus = 200;
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") return Response.json({ result: 200, response: [{ storageAddress: at, programName }] });
    if (String(input).endsWith(`stor-${"0".repeat(40)}`)) {
      return Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
    }
    return Response.json({ success: true, programName, owner, data: { present: true } }, { status: readStatus });
  };
  try {
    assert.equal((await probeNodeContract("https://node.example", programName)).ok, true,
      "the same search and payload certify a successful read");
    for (const status of [403, 404, 429, 500, 503]) {
      readStatus = status;
      const report = await probeNodeContract("https://node.example", programName);
      assert.equal(report.searchesAgree, true);
      assert.equal(report.storageNotFound, true);
      assert.equal(report.ok, false, `HTTP ${status} cannot certify a node deployment`);
    }
  } finally { globalThis.fetch = original; }
});
