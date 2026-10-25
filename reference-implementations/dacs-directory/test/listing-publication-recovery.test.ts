import assert from "node:assert/strict";
import test from "node:test";

import {
  LISTING_PUBLICATION_KEY,
  clearPendingListingPublication,
  discardPendingListingPublication,
  parsePendingListingPublication,
  readPendingListingPublication,
  readSavedListingPublication,
  writePendingListingPublication,
  type ExclusiveLocks,
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

/** Grants the lock to one callback at a time, in request order, as `navigator.locks` does across tabs. */
function exclusiveLocks(): ExclusiveLocks {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    request(_name, callback) {
      const run = tail.then(callback);
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

test("listing publication recovery records round-trip and clear", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  assert.equal(await writePendingListingPublication(storage, pending, exclusiveLocks()), true);
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

test("storage failures refuse unsafe publication persistence", async () => {
  const brokenWrite = { setItem: () => { throw new Error("quota"); } };
  const brokenRead = { getItem: () => "{" };
  assert.equal(await writePendingListingPublication(brokenWrite, pending, exclusiveLocks()), false);
  assert.equal(readPendingListingPublication(brokenRead), null);
});

test("a recovery record keeps only the members this version reads", () => {
  const withUnreadMembers = { ...pending, transactionRef: "9a".repeat(32), anchorReceipt: { blockNumber: 7 } };
  assert.deepEqual(parsePendingListingPublication(withUnreadMembers), pending);
});

function storageHolding(record: PendingListingPublication | null, options: { failRemove?: boolean; onRead?: () => void } = {}) {
  const values = new Map<string, string>();
  if (record) values.set(LISTING_PUBLICATION_KEY, JSON.stringify(record));
  return {
    values,
    getItem: (key: string) => { const value = values.get(key) ?? null; options.onRead?.(); return value; },
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { if (options.failRemove) throw new Error("denied"); values.delete(key); },
  };
}

function shownFrom(storage: ReturnType<typeof storageHolding>) {
  const shown = readSavedListingPublication(storage);
  assert.ok(shown);
  return shown;
}

test("discarding removes the saved record that was shown", async () => {
  const storage = storageHolding(pending);
  assert.equal(await discardPendingListingPublication(storage, shownFrom(storage), exclusiveLocks()), "discarded");
  assert.equal(storage.values.has(LISTING_PUBLICATION_KEY), false);
});

test("discarding keeps a record another tab saved after the shown one", async () => {
  const shown = shownFrom(storageHolding(pending));
  const replacement = { ...pending, listingId: "other-listing", anchorAddress: `stor-${"78".repeat(20)}`,
    registration: { ...pending.registration, listingAnchors: [`stor-${"78".repeat(20)}`] } };
  const storage = storageHolding(replacement);
  assert.equal(await discardPendingListingPublication(storage, shown, exclusiveLocks()), "changed");
  assert.deepEqual(readPendingListingPublication(storage), replacement);
});

test("discarding keeps a record another tab moved to a later stage", async () => {
  const shown = shownFrom(storageHolding(pending));
  const advanced = { ...pending, stage: "confirming" as const };
  const storage = storageHolding(advanced);
  assert.equal(await discardPendingListingPublication(storage, shown, exclusiveLocks()), "changed");
  assert.deepEqual(readPendingListingPublication(storage), advanced);
});

test("discarding keeps a record that only gained a member this version does not read", async () => {
  const shown = shownFrom(storageHolding(pending));
  const storage = storageHolding(null);
  const withTransactionRef = JSON.stringify({ ...pending, transactionRef: "9a".repeat(32) });
  storage.values.set(LISTING_PUBLICATION_KEY, withTransactionRef);
  assert.deepEqual(readPendingListingPublication(storage), pending);
  assert.equal(await discardPendingListingPublication(storage, shown, exclusiveLocks()), "changed");
  assert.equal(storage.values.get(LISTING_PUBLICATION_KEY), withTransactionRef);
});

test("a save made while discarding waits for the discard and is kept", async () => {
  const locks = exclusiveLocks();
  const newer = { ...pending, stage: "confirming" as const };
  let saving: Promise<boolean> | undefined;
  let discarding = false;
  const storage = storageHolding(pending, {
    onRead: () => { if (discarding) saving ??= writePendingListingPublication(storage, newer, locks); },
  });
  const shown = shownFrom(storage);
  discarding = true;
  assert.equal(await discardPendingListingPublication(storage, shown, locks), "discarded");
  assert.equal(await saving, true);
  assert.deepEqual(readPendingListingPublication(storage), newer);
});

test("discarding reports a record that is already gone as changed", async () => {
  const shown = shownFrom(storageHolding(pending));
  assert.equal(await discardPendingListingPublication(storageHolding(null), shown, exclusiveLocks()), "changed");
});

test("discarding reports a record the browser would not remove", async () => {
  const storage = storageHolding(pending, { failRemove: true });
  assert.equal(await discardPendingListingPublication(storage, shownFrom(storage), exclusiveLocks()), "failed");
  assert.deepEqual(readPendingListingPublication(storage), pending);
});

test("discarding removes nothing when cross-tab locking is unavailable", async () => {
  const storage = storageHolding(pending);
  assert.equal(await discardPendingListingPublication(storage, shownFrom(storage), undefined), "failed");
  assert.deepEqual(readPendingListingPublication(storage), pending);
});
