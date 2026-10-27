import assert from "node:assert/strict";
import test from "node:test";

import {
  decideListingNotice, type ListingNoticeDecision, type ListingNoticeInput, type ListingRejectionCode,
} from "../src/catalog/listingAdmission.js";

const actual = "a".repeat(64);
const other = "b".repeat(64);
const verified = (binding: ListingRejectionCode | null = null) => ({ kind: "verified" as const, contentHash: actual, binding });
const none = { signed: [], unknown: false };
const record = (code: ListingRejectionCode, publicNotice: boolean, coordinates = true): ListingNoticeDecision =>
  ({ action: "record", code, publicNotice, coordinates });
const hold: ListingNoticeDecision = { action: "hold" };
const clear: ListingNoticeDecision = { action: "clear" };

const cases: Array<[string, ListingNoticeInput, ListingNoticeDecision]> = [
  ["an unread anchor keeps whatever it had", { evidence: { kind: "unread" }, ownerSignedAnchor: true, declarations: { signed: [other], unknown: false } }, hold],
  ["an unread anchor with a held hash notice keeps it",
    { evidence: { kind: "unread" }, ownerSignedAnchor: false, declarations: none, heldCode: "DECLARED_CONTENT_HASH_MISMATCH" }, hold],
  ["unverifiable bytes are a private, coordinate-free rejection",
    { evidence: { kind: "invalid", code: "LISTING_SIGNATURE_INVALID" }, ownerSignedAnchor: true, declarations: none },
    record("LISTING_SIGNATURE_INVALID", false, false)],
  ["unverifiable bytes keep a held owner notice",
    { evidence: { kind: "invalid", code: "LISTING_SIGNATURE_INVALID" }, ownerSignedAnchor: true, declarations: none, heldCode: "OWNER_CLAIM_BINDING" }, hold],
  ["unverifiable bytes keep a held hash notice a signed source still declares",
    { evidence: { kind: "invalid", code: "NORMATIVE_LISTING_INVALID" }, ownerSignedAnchor: false, declarations: { signed: [actual], unknown: false },
      heldCode: "DECLARED_CONTENT_HASH_MISMATCH" }, hold],
  ["unverifiable bytes replace a held hash notice no source declares any more",
    { evidence: { kind: "invalid", code: "NORMATIVE_LISTING_INVALID" }, ownerSignedAnchor: false, declarations: none,
      heldCode: "DECLARED_CONTENT_HASH_MISMATCH" }, record("NORMATIVE_LISTING_INVALID", false, false)],
  ["a verified match clears and admits", { evidence: verified(), ownerSignedAnchor: false, declarations: { signed: [actual], unknown: false } }, clear],
  ["a verified match clears a held owner notice", { evidence: verified(), ownerSignedAnchor: true, declarations: none, heldCode: "OWNER_CLAIM_BINDING" }, clear],
  ["a signed mismatch is public", { evidence: verified(), ownerSignedAnchor: false, declarations: { signed: [actual, other], unknown: false } },
    record("DECLARED_CONTENT_HASH_MISMATCH", true)],
  ["an unsigned mismatch is private", { evidence: verified(), ownerSignedAnchor: true, declarations: { signed: [], unknown: false, unsigned: other } },
    record("DECLARED_CONTENT_HASH_MISMATCH", false)],
  ["a signed match overrides an unsigned mismatch",
    { evidence: verified(), ownerSignedAnchor: false, declarations: { signed: [actual], unknown: false, unsigned: other } }, clear],
  ["an unknown older source keeps a held hash notice even when every known declaration matches",
    { evidence: verified(), ownerSignedAnchor: false, declarations: { signed: [actual], unknown: true }, heldCode: "DECLARED_CONTENT_HASH_MISMATCH" }, hold],
  ["an unknown older source never creates a notice", { evidence: verified(), ownerSignedAnchor: false, declarations: { signed: [], unknown: true } }, clear],
  ["an owner-binding failure is public for an owner-signed pointer", { evidence: verified("OWNER_CLAIM_BINDING"), ownerSignedAnchor: true, declarations: none },
    record("OWNER_CLAIM_BINDING", true)],
  ["an owner-binding failure is private for a crawl pointer", { evidence: verified("OWNER_CLAIM_BINDING"), ownerSignedAnchor: false, declarations: none },
    record("OWNER_CLAIM_BINDING", false)],
  ["a seller-binding failure is private and has no coordinates", { evidence: verified("SELLER_CLAIM_BINDING"), ownerSignedAnchor: true, declarations: none },
    record("SELLER_CLAIM_BINDING", false, false)],
  ["an owner-binding failure replaces a held hash notice once every signed declaration matches",
    { evidence: verified("OWNER_CLAIM_BINDING"), ownerSignedAnchor: true, declarations: { signed: [actual], unknown: false },
      heldCode: "DECLARED_CONTENT_HASH_MISMATCH" }, record("OWNER_CLAIM_BINDING", true)],
  ["an owner-binding failure keeps a held hash notice another signed declaration contradicts",
    { evidence: verified("OWNER_CLAIM_BINDING"), ownerSignedAnchor: true, declarations: { signed: [actual, other], unknown: false },
      heldCode: "DECLARED_CONTENT_HASH_MISMATCH" }, hold],
];

for (const [name, input, expected] of cases) {
  test(`notice decision: ${name}`, () => assert.deepEqual(decideListingNotice(input), expected));
}
