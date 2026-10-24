import assert from "node:assert/strict";
import test from "node:test";
import {
  LISTING_REJECTION_CODES,
  LISTING_REJECTION_GUIDANCE,
  LISTING_REJECTION_MESSAGES,
  listingDiagnosticCoordinates as coordinates,
} from "../src/catalog/listingAdmission.js";

const MAX_PUBLIC_TEXT_LENGTH = 320;

test("diagnostic coordinates prefer the current listingId and listingVersion", () => {
  assert.deepEqual(coordinates({ listingId: "current", listingVersion: 2, serviceId: "legacy", version: 3 }),
    { listingId: "current", listingVersion: 2 });
});

test("diagnostic coordinates read the legacy serviceId and default its version to 1", () => {
  assert.deepEqual(coordinates({ serviceId: "legacy", version: 3 }), { listingId: "legacy", listingVersion: 3 });
  assert.deepEqual(coordinates({ serviceId: "legacy" }), { listingId: "legacy", listingVersion: 1 });
});

test("a current listingId without a valid listingVersion has no coordinates", () => {
  for (const raw of [
    { listingId: "a" },
    { listingId: "a", version: 7 },
    { listingId: "a", listingVersion: null, version: 4 },
    { listingId: "a", listingVersion: "2" },
  ]) {
    assert.equal(coordinates(raw), undefined, JSON.stringify(raw));
  }
});

test("diagnostic coordinates refuse an unusable identifier", () => {
  for (const raw of [{ serviceId: 123 }, { listingId: "", serviceId: "legacy" }, {}]) {
    assert.equal(coordinates(raw), undefined, JSON.stringify(raw));
  }
});

test("diagnostic coordinates accept a 128-character identifier and refuse 129", () => {
  assert.deepEqual(coordinates({ listingId: "a".repeat(128), listingVersion: 1 }),
    { listingId: "a".repeat(128), listingVersion: 1 });
  assert.equal(coordinates({ listingId: "a".repeat(129), listingVersion: 1 }), undefined);
});

test("diagnostic coordinates accept the URL-safe punctuation and refuse everything else", () => {
  assert.deepEqual(coordinates({ listingId: "A.z_9~-", listingVersion: 1 }), { listingId: "A.z_9~-", listingVersion: 1 });
  for (const listingId of ["a/b", "a b", "a?b", "café", "a\nb"]) {
    assert.equal(coordinates({ listingId, listingVersion: 1 }), undefined, JSON.stringify(listingId));
  }
});

test("diagnostic coordinates refuse versions that are not safe positive integers", () => {
  for (const version of [0, -1, 1.5, 2 ** 53, Number.NaN, "2", false]) {
    assert.equal(coordinates({ listingId: "a", listingVersion: version }), undefined, String(version));
    assert.equal(coordinates({ serviceId: "a", version }), undefined, String(version));
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
