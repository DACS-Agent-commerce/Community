import assert from "node:assert/strict";
import test from "node:test";
import { logicalToStorageProgramName, paymentEvidenceAddress } from "@kynesyslabs/dacs/canonical";
import { probeNodeContract } from "../src/catalog/nodeContract.js";

test("node contract probe checks metadata shape and records the SDK anchor mapping with its reported build", async () => {
  const logicalAddress = paymentEvidenceAddress("01J8ME0SXKQ4T9V2RC5HJ6WX7D", "demos-native:DEM", 2);
  const programName = logicalToStorageProgramName(logicalAddress);
  const storageAddress = `stor-${"1".repeat(40)}`;
  const commit = "12".repeat(20);
  const originalFetch = globalThis.fetch;
  let metadata: unknown = { logicalAddress };
  let servedName = programName;
  let buildAvailable = true;
  globalThis.fetch = async (input, init) => {
    assert.ok(init?.signal, "every node reply has a deadline");
    if (init?.method === "POST") {
      const request = JSON.parse(String(init.body));
      assert.deepEqual([...new Headers(init.headers)], [["content-type", "application/json"]]);
      if (request.params[0].message === "getNetworkInfo") {
        return buildAvailable
          ? Response.json({ result: 200, response: { nodeVersion: { commit, dirty: false } } })
          : new Response(null, { status: 503 });
      }
      return Response.json({ result: 200, response: [{ storageAddress, programName: servedName }] });
    }
    if (String(input).endsWith(`stor-${"0".repeat(40)}`)) {
      return Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
    }
    return Response.json({ success: true, programName: servedName, metadata,
      owner: `0x${"34".repeat(32)}`, data: { observed: true } });
  };
  try {
    const accepted = await probeNodeContract("https://node.example/", programName, logicalAddress);
    assert.equal(accepted.ok, true);
    assert.equal(accepted.storageMetadata, true);
    assert.equal(accepted.anchorMetadataMatches, true);
    assert.equal(accepted.build, commit, "the report records the observed build, without attesting it");
    assert.ok(!Number.isNaN(Date.parse(accepted.observedAt)));

    for (metadata of [undefined, [], "metadata", 7, false]) {
      const refused = await probeNodeContract("https://node.example", programName, logicalAddress);
      assert.equal(refused.storageMetadata, false, JSON.stringify(metadata));
      assert.equal(refused.ok, false);
    }
    for (metadata of [null, {}]) {
      assert.equal((await probeNodeContract("https://node.example", programName)).ok, true,
        "generic legacy storage permits null or object metadata");
      const refused = await probeNodeContract("https://node.example", programName, logicalAddress);
      assert.equal(refused.storageMetadata, true);
      assert.equal(refused.anchorMetadataMatches, false, "a known SDK anchor needs its logical address");
      assert.equal(refused.ok, false);
    }
    for (metadata of [{ logicalAddress: logicalAddress + ":other" }, { logicalAddress: { toString: null, valueOf: null } }]) {
      const refused = await probeNodeContract("https://node.example", programName, logicalAddress);
      assert.equal(refused.anchorMetadataMatches, false);
      assert.equal(refused.ok, false);
    }
    metadata = { logicalAddress };
    servedName = "opaque";
    assert.equal((await probeNodeContract("https://node.example", servedName, logicalAddress)).ok, false,
      "a caller cannot certify a program name that disagrees with the SDK mapping");
    servedName = programName;
    buildAvailable = false;
    const noBuild = await probeNodeContract("https://node.example", programName, logicalAddress);
    assert.equal(noBuild.build, null);
    assert.equal(noBuild.ok, false, "an anchor observation must identify the node build it checked");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("node contract report distinguishes unobserved metadata, generic observations and failed storage replies", async (t) => {
  const logicalAddress = paymentEvidenceAddress("01J8ME0SXKQ4T9V2RC5HJ6WX7D", "demos-native:DEM", 2);
  const programName = logicalToStorageProgramName(logicalAddress);
  const storageAddress = `stor-${"1".repeat(40)}`;
  const scenarios = [
    { name: "no candidate", candidate: false, throws: false, status: 200, success: true, metadata: {}, observed: false },
    { name: "throwing storage read", candidate: true, throws: true, status: 200, success: true, metadata: {}, observed: false },
    { name: "successful null metadata", candidate: true, throws: false, status: 200, success: true, metadata: null, observed: true },
    { name: "successful object metadata", candidate: true, throws: false, status: 200, success: true, metadata: {}, observed: true },
    { name: "failed HTTP with success-shaped body", candidate: true, throws: false, status: 503, success: true, metadata: {}, observed: false },
    { name: "HTTP 200 with success false", candidate: true, throws: false, status: 200, success: false, metadata: {}, observed: false },
  ];
  for (const scenario of scenarios) {
    for (const expectedAddress of [undefined, logicalAddress]) {
      await t.test(`${scenario.name}, ${expectedAddress === undefined ? "generic" : "requested anchor"}`, async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (input, init) => {
          assert.ok(init?.signal, "every node reply has a deadline");
          if (init?.method === "POST") {
            const request = JSON.parse(String(init.body));
            if (request.params[0].message === "getNetworkInfo") {
              return Response.json({ result: 200, response: { nodeVersion: { commit: "12".repeat(20), dirty: false } } });
            }
            return Response.json({ result: 200, response: scenario.candidate ? [{ storageAddress, programName }] : [] });
          }
          if (String(input).endsWith(`stor-${"0".repeat(40)}`)) {
            return Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
          }
          assert.equal(String(input), `https://node.example/storage-program/${storageAddress}`);
          if (scenario.throws) throw new Error("storage read failed");
          return Response.json({ success: scenario.success, programName, metadata: scenario.metadata,
            owner: `0x${"34".repeat(32)}`, data: { observed: true } }, { status: scenario.status });
        };
        try {
          const report = await probeNodeContract("https://node.example", programName, expectedAddress);
          assert.equal(report.storageMetadata, scenario.observed);
          assert.equal(report.anchorMetadataMatches, expectedAddress === undefined ? null : false,
            "generic probes make no anchor claim; metadata without a logical address cannot observe the requested anchor");
          assert.equal(report.ok, scenario.observed && expectedAddress === undefined);
        } finally {
          globalThis.fetch = originalFetch;
        }
      });
    }
  }
});

test("node contract probe binds an internally consistent SDK anchor to the requested logical address", async () => {
  const addressA = paymentEvidenceAddress("01J8ME0SXKQ4T9V2RC5HJ6WX7D", "demos-native:DEM", 2);
  const addressB = paymentEvidenceAddress("01J8ME0SXKQ4T9V2RC5HJ6WX7D", "demos-native:DEM", 3);
  const nameOfB = logicalToStorageProgramName(addressB);
  assert.notEqual(addressA, addressB);
  assert.notEqual(logicalToStorageProgramName(addressA), nameOfB);
  const storageAddress = `stor-${"1".repeat(40)}`;
  const commit = "12".repeat(20);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.ok(init?.signal, "every node reply has a deadline");
    if (init?.method === "POST") {
      const request = JSON.parse(String(init.body));
      if (request.params[0].message === "getNetworkInfo") {
        return Response.json({ result: 200, response: { nodeVersion: { commit, dirty: false } } });
      }
      return Response.json({ result: 200, response: [{ storageAddress, programName: nameOfB }] });
    }
    if (String(input).endsWith(`stor-${"0".repeat(40)}`)) {
      return Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
    }
    assert.equal(String(input), `https://node.example/storage-program/${storageAddress}`);
    return Response.json({ success: true, programName: nameOfB, metadata: { logicalAddress: addressB },
      owner: `0x${"34".repeat(32)}`, data: { observed: true } });
  };
  try {
    for (const [expectedAddress, matches] of [[addressA, false], [addressB, true]] as const) {
      const report = await probeNodeContract("https://node.example", nameOfB, expectedAddress);
      assert.equal(report.storageNotFound, true);
      assert.equal(report.nodeCallSearch, "supported");
      assert.equal(report.gcrRoutineSearch, "supported");
      assert.equal(report.searchesAgree, true);
      assert.equal(report.build, commit);
      assert.equal(report.storageMetadata, true, "B is a well-formed, self-consistent SDK anchor");
      assert.equal(report.anchorMetadataMatches, matches, "only the caller's expectation differs");
      assert.equal(report.ok, matches);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("node contract probe refuses self-consistent empty and padded addresses with every other check successful", async (t) => {
  const validAddress = paymentEvidenceAddress("01J8ME0SXKQ4T9V2RC5HJ6WX7D", "demos-native:DEM", 2);
  const storageAddress = `stor-${"1".repeat(40)}`;
  const commit = "12".repeat(20);
  for (const [label, logicalAddress, accepted] of [
    ["empty address", "", false],
    ["padded address", ` \t${validAddress}\n `, false],
    ["canonical address", validAddress, true],
  ] as const) {
    await t.test(label, async () => {
      // Map the same input the caller expects, including its whitespace. A
      // different expectation or name would mask the independent format check.
      const programName = logicalToStorageProgramName(logicalAddress);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        assert.ok(init?.signal, "every node reply has a deadline");
        if (init?.method === "POST") {
          const request = JSON.parse(String(init.body));
          if (request.params[0].message === "getNetworkInfo") {
            return Response.json({ result: 200, response: { nodeVersion: { commit, dirty: false } } });
          }
          return Response.json({ result: 200, response: [{ storageAddress, programName }] });
        }
        if (String(input).endsWith(`stor-${"0".repeat(40)}`)) {
          return Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
        }
        assert.equal(String(input), `https://node.example/storage-program/${storageAddress}`);
        return Response.json({ success: true, programName, metadata: { logicalAddress },
          owner: `0x${"34".repeat(32)}`, data: { observed: true } });
      };
      try {
        const report = await probeNodeContract("https://node.example", programName, logicalAddress);
        assert.equal(report.storageNotFound, true);
        assert.equal(report.nodeCallSearch, "supported");
        assert.equal(report.gcrRoutineSearch, "supported");
        assert.equal(report.searchesAgree, true);
        assert.equal(report.build, commit);
        assert.equal(report.storageMetadata, true);
        assert.equal(report.anchorMetadataMatches, accepted);
        assert.equal(report.ok, accepted);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});
