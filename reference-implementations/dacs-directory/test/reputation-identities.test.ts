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
const average = (deals: DealRecord[]) => {
  const retained = structuredClone(deals);
  const reputation = deriveSellerReputation(deals, 0, 200);
  assert.deepEqual(deals, retained, "TP-1 retains the original rating evidence");
  assert.equal(reputation.metricsProfile, "TP-1");
  return reputation.averageSellerRating;
};

test("TP-1 hides aggregate ratings for qualified CF-3 targets", () => {
  assert.equal(average([deal([rating({ target: `${seller}?channel=directory` })])]), null);
});

test("TP-1 hides aggregate ratings for rater aliases regardless of order", () => {
  const ratings = [
    rating({ value: 1, ratedAt: 20 }),
    rating({ rater: `${buyer}?channel=one`, value: 2, ratedAt: 10, contentHash: "z".repeat(64) }),
    rating({ rater: `${buyer}?channel=two`, target: `${seller}?channel=two`, value: 4, ratedAt: 20, contentHash: "b".repeat(64) }),
  ];
  assert.equal(average([deal(ratings)]), null);
  assert.equal(average([deal([...ratings].reverse())]), null);
});

test("qualified self-ratings cannot produce a TP-1 aggregate", () => {
  for (const [rater, target] of [
    [`${seller}?channel=self`, seller],
    [seller, `${seller}?channel=self`],
    [`${seller}?channel=one`, `${seller}?channel=two`],
  ]) {
    assert.equal(average([deal([rating({ rater, target })])]), null);
    assert.equal(average([deal([rating({ value: 1 }), rating({ rater, target })])]), null);
  }
});

test("TP-1 retains different raters and jobs without publishing their average", () => {
  const other = `did:demos:agent:${"ef".repeat(32)}`;
  assert.equal(average([
    deal([rating({ rater: `${buyer}?channel=one`, value: 1 }), rating({ rater: other, value: 3 })]),
    deal([rating({ rater: `${buyer}?channel=two`, value: 5 })], "other-job"),
  ]), null);
});

test("TP-1 hides aggregate ratings for non-canonical target keys", () => {
  const target = `did:demos:agent:${"CD".repeat(32)}`;
  assert.equal(average([deal([rating({ target })])]), null);
});
