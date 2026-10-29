import assert from "node:assert/strict";
import test from "node:test";
import "./fixtures/isolated-data-dir.js";
import { admitRevocationCandidates, hasPendingOwnerRevocationCandidate, recordRevocationProgress } from "../src/catalog/store.js";

const hash = "c".repeat(64);
const owner = `0x${"a".repeat(64)}`;

test("no candidate, an unknown owner or a foreign owner cannot establish an owner hold", () => {
  assert.equal(hasPendingOwnerRevocationCandidate(hash, owner), false, "no candidate is anchored yet");
  const locator = `stor-${"2".repeat(40)}`;
  admitRevocationCandidates(hash, [{ locator, owner }]);
  assert.equal(hasPendingOwnerRevocationCandidate(hash, owner), true);
  assert.equal(hasPendingOwnerRevocationCandidate(hash, `did:demos:agent:${"A".repeat(64)}`), true,
    "owners compare in canonical form");
  for (const listingOwner of [null, "", `0x${"b".repeat(64)}`]) {
    assert.equal(hasPendingOwnerRevocationCandidate(hash, listingOwner), false, String(listingOwner));
  }
  recordRevocationProgress(hash, { unread: [], rejected: [locator] });
  assert.equal(hasPendingOwnerRevocationCandidate(hash, owner), false, "a rejected candidate no longer holds");
});
