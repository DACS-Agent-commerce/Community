import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
const directory = mkdtempSync(join(tmpdir(), "dacs-revocation-retry-"));
process.env.DACS_DIRECTORY_DATA = directory;
const { admitRevocationCandidates, nextRevocationCandidates, hasPendingRevocationCandidates, recordRevocationProgress } = await import("../src/catalog/store.js");
test.after(() => rmSync(directory, { recursive: true, force: true }));

test("unresolved revocation candidates retain indeterminate standing throughout bounded backoff", () => {
  const hash = "a".repeat(64), locator = `stor-${"1".repeat(40)}`;
  const realNow = Date.now;
  let now = realNow(); Date.now = () => now;
  try {
    admitRevocationCandidates(hash, [{ locator }]);
    assert.deepEqual(nextRevocationCandidates(hash, null, 16), [locator]);
    for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
      recordRevocationProgress(hash, { unread: [locator], rejected: [] });
      assert.equal(hasPendingRevocationCandidates(hash), true);
      assert.deepEqual(nextRevocationCandidates(hash, null, 16), []);
      now += delay - 1;
      assert.deepEqual(nextRevocationCandidates(hash, null, 16), []);
      now++;
      assert.deepEqual(nextRevocationCandidates(hash, null, 16), [locator]);
    }
    recordRevocationProgress(hash, { unread: [], rejected: [locator] });
    assert.equal(hasPendingRevocationCandidates(hash), false);
  } finally { Date.now = realNow; }
});
