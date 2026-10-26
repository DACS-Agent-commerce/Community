import assert from "node:assert/strict";
import test from "node:test";
import { deriveSellerReputation } from "../src/catalog/reputation.js";
import type { DealRecord } from "../src/catalog/types.js";

const buyer = `did:demos:agent:${"ab".repeat(32)}`;
const seller = `did:demos:agent:${"cd".repeat(32)}`;
type Rating = NonNullable<DealRecord["ratings"]>[number];
const rating = (values: Partial<Rating> = {}): Rating => ({
  rater: buyer, target: seller, targetRole: "seller", value: 5,
  ratedAt: 10, contentHash: "a".repeat(64), ...values,
});
const deal = (ratings: Rating[], jobId = "rating-job"): DealRecord => ({
  jobId, rail: "pay-dem", buyerBundleRef: `stor-${"1".repeat(40)}`,
  owners: { buyer, seller }, signatureVerified: true, refsVerified: true,
  reputationEligible: true, sellerOutcome: "completed", finalisedAt: 100,
  verifiedAt: 100, ratings,
});
const average = (deals: DealRecord[]) => deriveSellerReputation(deals, 0, 200).averageSellerRating;

test("seller ratings match a qualified target by CF-3 identity", () => {
  assert.equal(average([deal([rating({ target: `${seller}?channel=directory` })])]), 5);
});

test("rater aliases share timestamp and content-hash selection regardless of order", () => {
  const ratings = [
    rating({ value: 1, ratedAt: 20 }),
    rating({ rater: `${buyer}?channel=one`, value: 2, ratedAt: 10, contentHash: "z".repeat(64) }),
    rating({ rater: `${buyer}?channel=two`, target: `${seller}?channel=two`, value: 4, ratedAt: 20, contentHash: "b".repeat(64) }),
  ];
  assert.equal(average([deal(ratings)]), 4);
  assert.equal(average([deal([...ratings].reverse())]), 4);
});

test("qualified self-ratings do not contribute to seller reputation", () => {
  for (const [rater, target] of [
    [`${seller}?channel=self`, seller],
    [seller, `${seller}?channel=self`],
    [`${seller}?channel=one`, `${seller}?channel=two`],
  ]) {
    assert.equal(average([deal([rating({ rater, target })])]), null);
    assert.equal(average([deal([rating({ value: 1 }), rating({ rater, target })])]), 1);
  }
});

test("canonical rater keys keep different raters and jobs independent", () => {
  const other = `did:demos:agent:${"ef".repeat(32)}`;
  assert.equal(average([
    deal([rating({ rater: `${buyer}?channel=one`, value: 1 }), rating({ rater: other, value: 3 })]),
    deal([rating({ rater: `${buyer}?channel=two`, value: 5 })], "other-job"),
  ]), 3);
});

test("seller rating matching does not repair non-canonical key casing", () => {
  const target = `did:demos:agent:${"CD".repeat(32)}`;
  assert.equal(average([deal([rating({ target })])]), null);
});
