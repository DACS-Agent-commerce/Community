import assert from "node:assert/strict";
import test from "node:test";
import "./fixtures/isolated-data-dir.js";
import { signedScope } from "../src/catalog/evidenceGraph.js";
import { indexWithCommitments as indexRegistration } from "./fixtures/commitment-proof.js";
import { bindingFor, dids, locator, maps, ref, registeredDeal, sign, vector, type Obj } from "./fixtures/current-evidence.js";

async function indexRatings(subjects: Array<{ rater: string; target: string; value: number; signer: number }>) {
  const fixture = await vector("rating-identities");
  const ratingRefs = await Promise.all(subjects.map(async ({ signer, ...values }, index) => {
    const scope = { ...signedScope(fixture.rating, "rating"), ...values, ratedAt: 110 + index };
    const raw = { ...scope, signature: await sign(scope, "rating", signer) };
    const at = locator(10 + index);
    maps.set(at, raw);
    return ref(at, raw, "rating");
  }));
  const bundleBindings = await Promise.all((["buyer", "seller"] as const).map(async (role, signer) => {
    const scope: Obj = { ...signedScope(role === "buyer" ? fixture.buyerBundle : fixture.sellerBundle, "bundle"), ratingRefs };
    const bundle = { ...scope, signatures: [await sign(scope, "bundle", 0, true), await sign(scope, "bundle", 1, true)], anchoredByRole: role };
    maps.set(fixture.locators[role], bundle);
    return bindingFor("rating-identities", role, fixture.locators[role], bundle, signer);
  }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const data = maps.get(String(input).split("/").pop() ?? "");
    return new Response(JSON.stringify(data
      ? { success: true, owner: `0x${dids[1].slice(-64)}`, programName: "dacs:test", data }
      : { success: false, errorCode: "NOT_FOUND" }), {
      status: data ? 200 : 404, headers: { "content-type": "application/json" },
    });
  };
  try {
    return await indexRegistration({
      primaryClaim: dids[1], displayName: "seller", listingAnchors: [fixture.locators.listing],
      deals: [registeredDeal("rating-identities", fixture.locators.buyer, fixture.locators.seller)], bundleBindings,
    }, undefined, async () => { throw new Error("identity unavailable"); });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

for (const [label, rater, target] of [
  ["rater", `${dids[0]}?channel=buyer`, dids[1]],
  ["target", dids[0], `${dids[1]}?channel=seller`],
  ["rater and target", `${dids[0]}?channel=buyer`, `${dids[1]}?channel=seller`],
]) {
  test(`signed ratings with a qualified ${label} reach seller reputation`, async () => {
    const record = await indexRatings([{ rater, target, value: 5, signer: 0 }]);
    assert.equal(record.deals[0].refsVerified, true);
    assert.equal(record.reputation.averageSellerRating, 5);
    assert.equal(record.deals[0].ratings?.[0].rater, rater);
    assert.equal(record.deals[0].ratings?.[0].target, target);
  });
}

test("signed aliases contribute only the latest rating for a rater and job", async () => {
  const record = await indexRatings([
    { rater: dids[0], target: dids[1], value: 1, signer: 0 },
    { rater: `${dids[0]}?channel=buyer`, target: `${dids[1]}?channel=seller`, value: 5, signer: 0 },
  ]);
  assert.equal(record.deals[0].refsVerified, true);
  assert.equal(record.deals[0].ratings?.length, 2);
  assert.equal(record.reputation.averageSellerRating, 5);
});

test("a signed qualified self-rating is excluded from seller reputation", async () => {
  const record = await indexRatings([
    { rater: dids[0], target: dids[1], value: 1, signer: 0 },
    { rater: `${dids[1]}?channel=self`, target: dids[1], value: 5, signer: 1 },
  ]);
  assert.equal(record.deals[0].refsVerified, true);
  assert.equal(record.deals[0].ratings?.length, 2);
  assert.equal(record.reputation.averageSellerRating, 1);
});
