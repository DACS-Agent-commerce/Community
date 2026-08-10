import assert from "node:assert/strict";
import test from "node:test";

import {
  LISTING_PUBLICATION_KEY,
  clearPendingListingPublication,
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
