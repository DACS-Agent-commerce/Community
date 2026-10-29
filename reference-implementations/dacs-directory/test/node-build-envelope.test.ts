import assert from "node:assert/strict";
import test from "node:test";
import { PINNED_DEMOS_NODE_BUILDS } from "../src/catalog/nodeDeployment.js";

test("absent, primitive and array network info envelopes report no build", async () => {
  const { reportedNodeBuild } = await import("../src/catalog/nodeDeployment.js");
  for (const info of [null, undefined, 0, 7, false, true, "node", [], ["node"], {},
    { nodeVersion: null }, { nodeVersion: 7 }, { nodeVersion: [] }]) {
    assert.equal(reportedNodeBuild(info), null, JSON.stringify(info));
  }
  assert.equal(reportedNodeBuild({ nodeVersion: { commit: PINNED_DEMOS_NODE_BUILDS[0], dirty: false } }), PINNED_DEMOS_NODE_BUILDS[0]);
});
