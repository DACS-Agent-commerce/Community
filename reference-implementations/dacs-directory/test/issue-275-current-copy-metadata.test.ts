import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import "./fixtures/isolated-data-dir.js";
import { indexWithCommitments as indexRegistration } from "./fixtures/commitment-proof.js";
import { vector, maps, dids, registeredDeal, bindingFor, sign, graphAt, type Obj } from "./fixtures/current-evidence.js";
import { signedScope } from "../src/catalog/evidenceGraph.js";
import { reconcileCurrentCopies } from "../src/catalog/currentReconciliation.js";
import { saveCatalog, loadStoredCatalog } from "../src/catalog/store.js";

const absent = Symbol("absent");
type Side = "buyer" | "seller";
type Change = { outcome?: unknown; anchoredByRole?: unknown; unsigned?: boolean };

async function exercise(t: TestContext, name: string, profile: "bundle" | "fault", changes: Partial<Record<Side, Change>>) {
  const fixture = await vector("issue-275-" + name, 8250);
  for (const [side, signer] of [["buyer", 0], ["seller", 1]] as const) {
    const change = changes[side] ?? {};
    const scope = signedScope(side === "buyer" ? fixture.buyerBundle : fixture.sellerBundle, "bundle");
    if (profile === "fault") { delete scope.bundleVersion; scope.faultBundleVersion = "1"; scope.faultedParty = "none"; }
    if (Object.hasOwn(change, "outcome")) {
      if (change.outcome === absent) delete scope.outcome;
      else scope.outcome = change.outcome;
    }
    const raw: Obj = { ...scope, signatures: change.unsigned ? [] : [await sign(scope, "bundle", 0, true), await sign(scope, "bundle", 1, true)] };
    if (!Object.hasOwn(change, "anchoredByRole")) raw.anchoredByRole = side;
    else if (change.anchoredByRole !== absent) raw.anchoredByRole = change.anchoredByRole;
    maps.set(fixture.locators[side], raw);
    if (signer === 0) fixture.buyerBundle = raw;
    else fixture.sellerBundle = raw;
  }
  const buyerGraph = await graphAt(fixture.locators.buyer, fixture.listing, fixture.locators.listing);
  const sellerGraph = await graphAt(fixture.locators.seller, fixture.listing, fixture.locators.listing);
  const deal = registeredDeal("issue-275-" + name, fixture.locators.buyer, fixture.locators.seller);
  const bundleBindings = [
    await bindingFor(deal.jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
    await bindingFor(deal.jobId, "seller", fixture.locators.seller, fixture.sellerBundle, 1),
  ];
  const read = { buyer: 0, seller: 0 };
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const at = String(input).split("/").pop() ?? "";
    for (const side of ["buyer", "seller"] as const) if (at === fixture.locators[side]) read[side]++;
    const data = maps.get(at);
    return new Response(JSON.stringify(data ? { success: true, owner: `0x${dids[1].slice(-64)}`, programName: "dacs:test", data } : { success: false }),
      { status: data ? 200 : 404, headers: { "content-type": "application/json" } });
  });
  const indexed = await indexRegistration({ primaryClaim: dids[1], displayName: "seller", listingAnchors: [fixture.locators.listing], deals: [deal], bundleBindings },
    undefined, async () => { throw new Error("offline identity unavailable"); });
  assert.equal(indexed.deals.length, 1, "the real indexer must emit a deal record");
  assert.ok(read.buyer > 0 && read.seller > 0, "both actual storage copies must have been fetched");
  saveCatalog({ catalogVersion: "1", generatedAt: 12345, sellers: [indexed] });
  const stored = loadStoredCatalog().sellers[0].deals[0];
  return { indexed: indexed.deals[0], stored, buyerGraph, sellerGraph, deal };
}

for (const profile of ["bundle", "fault"] as const) {
  test(`#275 ${profile}: verified string outcome and seller role persist`, async (t) => {
    const x = await exercise(t, profile + "-valid", profile, {});
    assert.equal(x.buyerGraph.ok, true, x.buyerGraph.reason);
    assert.equal(x.sellerGraph.ok, true, x.sellerGraph.reason);
    for (const deal of [x.indexed, x.stored]) {
      assert.equal(deal.outcome, "completed"); assert.equal(deal.anchoredByRole, "seller");
      assert.equal(deal.refsVerified, true);
    }
  });
  const cases: Array<[string, Change]> = [
    ["number-and-invalid-role", { outcome: 7, anchoredByRole: "provider" }],
    ["zero", { outcome: 0 }], ["false", { outcome: false }], ["null", { outcome: null }],
    ["array", { outcome: ["completed"] }], ["object", { outcome: { outcome: "completed" } }],
    ["missing-outcome", { outcome: absent }], ["number-role", { anchoredByRole: 7 }],
    ["array-role", { anchoredByRole: ["seller"] }], ["object-role", { anchoredByRole: { role: "seller" } }],
    ["null-role", { anchoredByRole: null }], ["missing-role", { anchoredByRole: absent }],
    ["wrong-role-case", { anchoredByRole: "Seller" }], ["padded-role", { anchoredByRole: "seller " }],
    ["empty-role", { anchoredByRole: "" }], ["empty-outcome", { outcome: "" }],
    ["no-signatures", { unsigned: true }],
  ];
  for (const sides of [["buyer"], ["seller"], ["buyer", "seller"]] as Side[][]) {
    for (const [name, change] of cases) {
      test(`#275 ${profile}: ${sides.join("+")} ${name} cannot enter a stored deal`, async (t) => {
        const x = await exercise(t, profile + "-" + sides.join("-") + "-" + name, profile, Object.fromEntries(sides.map(side => [side, change])));
        for (const side of sides) assert.equal((side === "buyer" ? x.buyerGraph : x.sellerGraph).ok, false, "malformed copy is rejected before binding inspection");
        for (const deal of [x.indexed, x.stored]) {
          assert.equal(deal.outcome, undefined, "no metadata from an unresolved current-copy pair");
          assert.equal(deal.anchoredByRole, undefined, "no unverified role may persist");
          assert.equal(deal.refsVerified, false);
          assert.equal(deal.signatureVerified, false);
          assert.equal(deal.reputationEligible, false);
        }
        assert.equal(Object.hasOwn(x.stored, "outcome"), false, "JSON persistence omits undefined outcome");
        assert.equal(Object.hasOwn(x.stored, "anchoredByRole"), false, "JSON persistence omits undefined role");
      });
    }
  }
}

test("#275 the helper fallback alone is not the indexer's admission path", async (t) => {
  const x = await exercise(t, "helper-vs-caller", "bundle", { buyer: { outcome: 7, anchoredByRole: "provider" }, seller: { unsigned: true } });
  const selected = reconcileCurrentCopies(x.deal, dids[1], x.buyerGraph, x.sellerGraph);
  assert.equal(selected.buyerOk, false); assert.equal(selected.sellerOk, false);
  assert.equal(selected.authoritative, x.buyerGraph);
  assert.equal(selected.authoritative.bundle.outcome, 7);
  assert.equal(selected.authoritative.bundle.anchoredByRole, "provider");
  assert.equal(x.stored.outcome, undefined); assert.equal(x.stored.anchoredByRole, undefined);
});
