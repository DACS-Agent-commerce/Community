import assert from "node:assert/strict";
import test from "node:test";
import {
  LISTING_REJECTION_CODES,
  LISTING_REJECTION_GUIDANCE,
  LISTING_REJECTION_MESSAGES,
  listingDiagnosticCoordinates as coordinates,
} from "../src/catalog/listingAdmission.js";

const MAX_PUBLIC_TEXT_LENGTH = 320;

test("a current Listing reads its listingId and listingVersion, not the legacy members", () => {
  assert.deepEqual(coordinates({ dacsVersion: "1", listingId: "current", listingVersion: 2, serviceId: "legacy" }),
    { listingId: "current", listingVersion: 2 });
});

test("a legacy Listing reads its serviceId and listingVersion at versions 1 and 2", () => {
  assert.deepEqual(coordinates({ serviceId: "legacy", listingVersion: 1 }), { listingId: "legacy", listingVersion: 1 });
  assert.deepEqual(coordinates({ serviceId: "legacy", listingVersion: 2 }), { listingId: "legacy", listingVersion: 2 });
});

test("a legacy Listing defaults to version 1 only when listingVersion is absent", () => {
  assert.deepEqual(coordinates({ serviceId: "legacy" }), { listingId: "legacy", listingVersion: 1 });
  for (const listingVersion of [null, 0, "2"]) {
    assert.equal(coordinates({ serviceId: "legacy", listingVersion }), undefined, String(listingVersion));
  }
});

test("a legacy Listing ignores a conflicting listingId and the unrelated version member", () => {
  assert.deepEqual(coordinates({ serviceId: "legacy", listingId: "other", listingVersion: 2, version: 3 }),
    { listingId: "legacy", listingVersion: 2 });
});

test("a legacy listing that declares listingVersion keeps it in its coordinates", () => {
  assert.deepEqual(coordinates({ serviceId: "legacy", listingVersion: 3 }), { listingId: "legacy", listingVersion: 3 });
});

test("a current listingId without a valid listingVersion has no coordinates", () => {
  for (const raw of [
    { dacsVersion: "1", listingId: "a" },
    { dacsVersion: "1", listingId: "a", version: 7 },
    { dacsVersion: "1", listingId: "a", listingVersion: null, version: 4 },
    { dacsVersion: "1", listingId: "a", listingVersion: "2" },
  ]) {
    assert.equal(coordinates(raw), undefined, JSON.stringify(raw));
  }
});

test("diagnostic coordinates refuse an unusable identifier", () => {
  for (const raw of [{ serviceId: 123 }, { dacsVersion: "1", listingId: "", serviceId: "legacy" }, { dacsVersion: "1", serviceId: "legacy" }, {}]) {
    assert.equal(coordinates(raw), undefined, JSON.stringify(raw));
  }
});

test("diagnostic coordinates accept a 128-character identifier and refuse 129", () => {
  assert.deepEqual(coordinates({ dacsVersion: "1", listingId: "a".repeat(128), listingVersion: 1 }),
    { listingId: "a".repeat(128), listingVersion: 1 });
  assert.equal(coordinates({ dacsVersion: "1", listingId: "a".repeat(129), listingVersion: 1 }), undefined);
});

test("diagnostic coordinates accept the URL-safe punctuation and refuse everything else", () => {
  assert.deepEqual(coordinates({ dacsVersion: "1", listingId: "A.z_9~-", listingVersion: 1 }), { listingId: "A.z_9~-", listingVersion: 1 });
  for (const listingId of ["a/b", "a b", "a?b", "café", "a\nb"]) {
    assert.equal(coordinates({ dacsVersion: "1", listingId, listingVersion: 1 }), undefined, JSON.stringify(listingId));
  }
});

test("diagnostic coordinates refuse versions that are not safe positive integers", () => {
  for (const version of [0, -1, 1.5, 2 ** 53, Number.NaN, "2", false]) {
    assert.equal(coordinates({ dacsVersion: "1", listingId: "a", listingVersion: version }), undefined, String(version));
    assert.equal(coordinates({ serviceId: "a", listingVersion: version }), undefined, String(version));
  }
});

test("every rejection code has one bounded public message and guidance", () => {
  assert.equal(new Set(LISTING_REJECTION_CODES).size, LISTING_REJECTION_CODES.length);
  assert.deepEqual(Object.keys(LISTING_REJECTION_MESSAGES).sort(), [...LISTING_REJECTION_CODES].sort());
  assert.deepEqual(Object.keys(LISTING_REJECTION_GUIDANCE).sort(), [...LISTING_REJECTION_CODES].sort());
  for (const code of LISTING_REJECTION_CODES) {
    for (const text of [LISTING_REJECTION_MESSAGES[code], LISTING_REJECTION_GUIDANCE[code]]) {
      assert.ok(text.length > 0 && text.length <= MAX_PUBLIC_TEXT_LENGTH, `${code}: ${text.length}`);
    }
  }
});

test("replacement guidance for an invalid candidate allows a new signed version under the same ID", () => {
  for (const code of ["NORMATIVE_LISTING_INVALID", "VERIFICATION_METHOD_INVALID"] as const) {
    assert.match(LISTING_REJECTION_GUIDANCE[code], /new signed Listing version/, code);
  }
});
