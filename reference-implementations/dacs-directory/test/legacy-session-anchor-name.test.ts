import assert from "node:assert/strict";
import test from "node:test";
import { legacySessionAnchorName } from "../src/catalog/legacySessionAnchorName.js";

test("historical anchor names keep the raw job id, including reserved characters", () => {
  const jobId = "job/1 é?#%20&=+";
  assert.equal(legacySessionAnchorName.agreement(jobId), `dacs3:agreement:${jobId}`);
  assert.equal(legacySessionAnchorName.evidence(jobId), `dacs4:evidence:${jobId}`);
  assert.equal(legacySessionAnchorName.vet(jobId), `dacs2:verifyrecord:${jobId}`);
});
