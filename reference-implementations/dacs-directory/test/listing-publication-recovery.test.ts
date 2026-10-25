import assert from "node:assert/strict";
import test from "node:test";

import {
  LISTING_PUBLICATION_KEY,
  clearPendingListingPublication,
  discardPendingListingPublication,
  parsePendingListingPublication,
  readPendingListingPublication,
  writePendingListingPublication,
  type PendingListingPublication,
} from "../src/components/listing-publication-recovery.js";

const claim = `did:demos:agent:${"12".repeat(32)}`;
const anchorAddress = `stor-${"34".repeat(20)}`;
const pending: PendingListingPublication = {
  version: 1,
  claim,
  listingId: "code-review",
  listingVersion: 1,
  anchorAddress,
  programName: "dacs1-ZGFjczE",
  contentHash: "56".repeat(32),
  signedListing: { dacsVersion: "1", listingId: "code-review", listingVersion: 1, signature: {} },
  transaction: { content: { nonce: 4 } },
  registration: { primaryClaim: claim, displayName: "Code reviewer", listingAnchors: [anchorAddress], deals: [] },
  stage: "broadcast-uncertain",
  createdAt: 1_786_360_000_000,
};

test("listing publication recovery records round-trip and clear", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  assert.equal(writePendingListingPublication(storage, pending), true);
  assert.deepEqual(readPendingListingPublication(storage), pending);
  clearPendingListingPublication(storage);
  assert.equal(values.has(LISTING_PUBLICATION_KEY), false);
});

test("listing publication recovery fails closed on malformed or cross-bound state", () => {
  assert.equal(parsePendingListingPublication({ ...pending, version: 2 }), null);
  assert.equal(parsePendingListingPublication({ ...pending, claim: `did:demos:agent:${"AB".repeat(32)}` }), null);
  assert.equal(parsePendingListingPublication({ ...pending, listingVersion: 0 }), null);
  assert.equal(parsePendingListingPublication({ ...pending, contentHash: "not-a-hash" }), null);
  assert.equal(parsePendingListingPublication({
    ...pending,
    registration: { ...pending.registration, primaryClaim: `did:demos:agent:${"78".repeat(32)}` },
  }), null);
  assert.equal(parsePendingListingPublication({
    ...pending,
    registration: { ...pending.registration, listingAnchors: [] },
  }), null);
  assert.equal(parsePendingListingPublication({ ...pending, transaction: [] }), null);
});

test("storage failures refuse unsafe publication persistence", () => {
  const brokenWrite = { setItem: () => { throw new Error("quota"); } };
  const brokenRead = { getItem: () => "{" };
  assert.equal(writePendingListingPublication(brokenWrite, pending), false);
  assert.equal(readPendingListingPublication(brokenRead), null);
});

test("a recovery record keeps only the members this version reads", () => {
  const withUnreadMembers = { ...pending, transactionRef: "9a".repeat(32), anchorReceipt: { blockNumber: 7 } };
  assert.deepEqual(parsePendingListingPublication(withUnreadMembers), pending);
});

function storageHolding(record: PendingListingPublication | null, options: { failRemove?: boolean } = {}) {
  const values = new Map<string, string>();
  if (record) values.set(LISTING_PUBLICATION_KEY, JSON.stringify(record));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => { if (options.failRemove) throw new Error("denied"); values.delete(key); },
  };
}

test("discarding removes the saved record that was shown", () => {
  const storage = storageHolding(pending);
  assert.equal(discardPendingListingPublication(storage, pending), "discarded");
  assert.equal(storage.values.has(LISTING_PUBLICATION_KEY), false);
});

test("discarding keeps a record another tab saved after the shown one", () => {
  const replacement = { ...pending, listingId: "other-listing", anchorAddress: `stor-${"78".repeat(20)}`,
    registration: { ...pending.registration, listingAnchors: [`stor-${"78".repeat(20)}`] } };
  const storage = storageHolding(replacement);
  assert.equal(discardPendingListingPublication(storage, pending), "changed");
  assert.deepEqual(readPendingListingPublication(storage), replacement);
});

test("discarding keeps a record another tab moved to a later stage", () => {
  const advanced = { ...pending, stage: "confirming" as const };
  const storage = storageHolding(advanced);
  assert.equal(discardPendingListingPublication(storage, pending), "changed");
  assert.deepEqual(readPendingListingPublication(storage), advanced);
});

test("discarding reports a record that is already gone as changed", () => {
  assert.equal(discardPendingListingPublication(storageHolding(null), pending), "changed");
});

test("discarding reports a record the browser would not remove", () => {
  const storage = storageHolding(pending, { failRemove: true });
  assert.equal(discardPendingListingPublication(storage, pending), "failed");
  assert.deepEqual(readPendingListingPublication(storage), pending);
});
