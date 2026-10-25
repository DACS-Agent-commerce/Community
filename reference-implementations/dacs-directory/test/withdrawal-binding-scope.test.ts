import assert from "node:assert/strict";
import test from "node:test";
import "./fixtures/isolated-data-dir.js";
import { admitRevocationCandidates, boundWellKnownRevocations, hasPendingOwnerRevocationCandidate,
  recordWellKnownWithdrawalCheck } from "../src/catalog/store.js";
import type { RevocationBinding } from "../src/catalog/types.js";

const seller = `did:demos:agent:${"a".repeat(64)}`;
const other = `did:demos:agent:${"b".repeat(64)}`;
const hash = "c".repeat(64);
const binding: RevocationBinding = {
  sellerPrimaryClaim: seller, listingId: "service", listingVersion: 1, listingContentHash: hash,
  logicalAddress: `dacs1-revoked:${encodeURIComponent(seller)}:service:v1`,
  markerAnchor: { kind: "storage-program", locator: `stor-${"1".repeat(40)}` }, markerContentHash: "d".repeat(64),
};

test("source bindings match seller, content hash, listing id, and version independently", () => {
  const anotherHash = { ...binding, listingContentHash: "e".repeat(64) };
  recordWellKnownWithdrawalCheck("https://scope.example", seller, [hash, anotherHash.listingContentHash], [],
    { generatedAt: 1, hash: "f".repeat(64) }, [binding, anotherHash]);
  assert.deepEqual(boundWellKnownRevocations(seller, hash, "service", 1), [binding]);
  assert.deepEqual(boundWellKnownRevocations(seller, anotherHash.listingContentHash, "service", 1), [anotherHash]);
  for (const [who, content, id, version] of [[other, hash, "service", 1], [seller, "9".repeat(64), "service", 1],
    [seller, hash, "other-service", 1], [seller, hash, "service", 2]] as const) {
    assert.deepEqual(boundWellKnownRevocations(who, content, id, version), [], `${who}/${content}/${id}/${version}`);
  }
});

test("a populated candidate cannot establish authority when the Listing owner is unknown", () => {
  const locator = `stor-${"2".repeat(40)}`;
  const owner = `0x${"a".repeat(64)}`;
  admitRevocationCandidates(hash, [{ locator, owner }]);
  assert.equal(hasPendingOwnerRevocationCandidate(hash, owner), true);
  for (const listingOwner of [null, "", `0x${"b".repeat(64)}`]) {
    assert.equal(hasPendingOwnerRevocationCandidate(hash, listingOwner), false);
  }
});

test("each stored binding must match its source seller even when every Listing coordinate matches", () => {
  const content = "8".repeat(64);
  const foreign = { ...binding, listingContentHash: content, sellerPrimaryClaim: other };
  recordWellKnownWithdrawalCheck("https://foreign-binding.example", seller, [content], [],
    { generatedAt: 1, hash: "7".repeat(64) }, [foreign]);
  assert.deepEqual(boundWellKnownRevocations(seller, content, "service", 1), []);
});
