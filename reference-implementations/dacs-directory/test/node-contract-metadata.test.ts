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
