import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import "./fixtures/isolated-data-dir.js";
// Namespace import: a missing export fails its own tests instead of the whole file.
import * as indexer from "../src/catalog/indexer.js";
import { fixtureCommitments } from "./fixtures/commitment-proof.js";
import { vector, maps, dids, registeredDeal, bindingFor, sign, graphAt, type Obj } from "./fixtures/current-evidence.js";
import { signedScope, type EvidenceGraph } from "../src/catalog/evidenceGraph.js";
import type { BundleBinding, RegisteredDeal } from "../src/catalog/types.js";

// Community #354: when the indexer refuses a deal's bundle side it must say why, with the bundle
// locator and the job id. Recording only: which bundles are accepted does not change.

const offline = async () => { throw new Error("offline identity unavailable"); };

function serve(t: TestContext) {
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const at = String(input).split("/").pop() ?? "";
    const data = maps.get(at);
    return new Response(JSON.stringify(data ? { success: true, owner: `0x${dids[1].slice(-64)}`, programName: "dacs:test", data } : { success: false }),
      { status: data ? 200 : 404, headers: { "content-type": "application/json" } });
  });
}

async function index(t: TestContext, listingLocator: string, deal: RegisteredDeal, bundleBindings: BundleBinding[]) {
  serve(t);
  const refusals: indexer.BundleRefusal[] = [];
  const record = await indexer.indexRegistration(
    { primaryClaim: dids[1], displayName: "seller", listingAnchors: [listingLocator], deals: [deal], bundleBindings },
    undefined, offline, undefined, undefined, undefined, fixtureCommitments, undefined, false,
    (refusal) => refusals.push(refusal),
  );
  assert.equal(record.deals.length, 1, "the indexer emits a record for the deal");
  return { record, refusals };
}

/** A copy of one side's bundle with its signed scope changed and re-signed (or signed as given). */
async function resign(raw: Obj, role: "buyer" | "seller", change: (scope: Obj) => void, signatures?: (scope: Obj) => Promise<Obj[]>) {
  const scope = signedScope(raw, "bundle");
  change(scope);
  return { ...scope, signatures: signatures ? await signatures(scope) : [await sign(scope, "bundle", 0, true), await sign(scope, "bundle", 1, true)], anchoredByRole: role };
}

test("#354 control: an accepted current bundle pair records no refusal", async (t) => {
  const fixture = await vector("issue-354-accepted", 9100);
  const deal = registeredDeal("issue-354-accepted", fixture.locators.buyer, fixture.locators.seller);
  const { record, refusals } = await index(t, fixture.locators.listing, deal, [
    await bindingFor(deal.jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
    await bindingFor(deal.jobId, "seller", fixture.locators.seller, fixture.sellerBundle, 1),
  ]);
  assert.equal(record.deals[0].signatureVerified, true, "both sides were accepted");
  assert.equal(record.deals[0].refsVerified, true);
  assert.deepEqual(refusals, []);
});

test("#354 graph not ok: the refusal carries the graph's reason, locator and job id", async (t) => {
  const fixture = await vector("issue-354-graph", 9150);
  const seller = await resign(fixture.sellerBundle, "seller", (scope) => { scope.outcome = 7; });
  maps.set(fixture.locators.seller, seller);
  const graph = await graphAt(fixture.locators.seller, fixture.listing, fixture.locators.listing);
  assert.equal(graph.ok, false);
  assert.equal(graph.reason, "invalid current DACS-5 bundle shape");
  const deal = registeredDeal("issue-354-graph", fixture.locators.buyer, fixture.locators.seller);
  const { record, refusals } = await index(t, fixture.locators.listing, deal, [
    await bindingFor(deal.jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
    await bindingFor(deal.jobId, "seller", fixture.locators.seller, seller, 1),
  ]);
  assert.equal(record.deals[0].signatureVerified, false, "the refused side still leaves the deal unverified");
  assert.deepEqual(refusals, [{ jobId: deal.jobId, role: "seller", locator: fixture.locators.seller, reason: graph.reason }]);
});

test("#354 signatures not verified: a forged party signature is refused with the graph's signature reason", async (t) => {
  const fixture = await vector("issue-354-signature", 9200);
  // The seller party's signature is made with another key.
  const seller = await resign(fixture.sellerBundle, "seller", () => {}, async (scope) =>
    [await sign(scope, "bundle", 0, true), { ...await sign(scope, "bundle", 2, true), party: dids[1] }]);
  maps.set(fixture.locators.seller, seller);
  const graph = await graphAt(fixture.locators.seller, fixture.listing, fixture.locators.listing);
  assert.equal(graph.ok, false);
  assert.equal(graph.signaturesVerified, false);
  assert.equal(graph.reason, "required current bundle signatures are missing or invalid");
  const deal = registeredDeal("issue-354-signature", fixture.locators.buyer, fixture.locators.seller);
  const { record, refusals } = await index(t, fixture.locators.listing, deal, [
    await bindingFor(deal.jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
    await bindingFor(deal.jobId, "seller", fixture.locators.seller, seller, 1),
  ]);
  assert.equal(record.deals[0].signatureVerified, false);
  assert.deepEqual(refusals, [{ jobId: deal.jobId, role: "seller", locator: fixture.locators.seller, reason: graph.reason }]);
});

test("#354 job id mismatch: a binding that points at another job's valid bundle is refused with fixed text", async (t) => {
  const other = await vector("issue-354-other-job", 9300);
  const otherObjects = [...maps];
  const fixture = await vector("issue-354-job", 9350);
  for (const [at, value] of otherObjects) maps.set(at, value);
  const graph = await graphAt(other.locators.seller, other.listing, other.locators.listing);
  assert.equal(graph.ok, true, graph.reason);
  assert.equal(graph.bundle.jobId, "issue-354-other-job");
  const deal = registeredDeal("issue-354-job", fixture.locators.buyer, fixture.locators.seller);
  const { record, refusals } = await index(t, fixture.locators.listing, deal, [
    await bindingFor(deal.jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
    await bindingFor(deal.jobId, "seller", other.locators.seller, other.sellerBundle, 1),
  ]);
  assert.equal(record.deals[0].signatureVerified, false);
  assert.deepEqual(refusals, [{ jobId: deal.jobId, role: "seller", locator: other.locators.seller,
    reason: "bundle job id does not match the binding" }]);
});

test("#354 wrong anchoring role: a seller binding to the buyer-anchored copy is refused with fixed text", async (t) => {
  const fixture = await vector("issue-354-role", 9400);
  const deal = registeredDeal("issue-354-role", fixture.locators.buyer, fixture.locators.seller);
  const { record, refusals } = await index(t, fixture.locators.listing, deal, [
    await bindingFor(deal.jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
    await bindingFor(deal.jobId, "seller", fixture.locators.buyer, fixture.buyerBundle, 1),
  ]);
  assert.equal(record.deals[0].signatureVerified, false);
  assert.deepEqual(refusals, [{ jobId: deal.jobId, role: "seller", locator: fixture.locators.buyer,
    reason: "bundle anchoring role does not match the binding role" }]);
});

test("#354 wrong role holder: a buyer binding whose signer is not the bundle's buyer is refused with fixed text", async (t) => {
  const fixture = await vector("issue-354-holder", 9450);
  // The registered buyer (and binding signer) is dids[2]; the bundle names dids[0] as buyer.
  const deal: RegisteredDeal = { ...registeredDeal("issue-354-holder", fixture.locators.buyer, fixture.locators.seller),
    owners: { buyer: dids[2], seller: dids[1] } };
  const { record, refusals } = await index(t, fixture.locators.listing, deal, [
    await bindingFor(deal.jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 2),
    await bindingFor(deal.jobId, "seller", fixture.locators.seller, fixture.sellerBundle, 1),
  ]);
  assert.equal(record.deals[0].signatureVerified, false);
  assert.deepEqual(refusals, [{ jobId: deal.jobId, role: "buyer", locator: fixture.locators.buyer,
    reason: "bundle role holder is not the binding signer" }]);
});

// The refusal decision itself, branch by branch. `buildCurrentEvidenceGraph` never returns ok with
// unverified signatures, so that branch is reachable only here.
test("#354 bundleSideRefusal names each refusal and accepts what inspect accepted", async () => {
  const refusalOf = indexer.bundleSideRefusal;
  assert.equal(typeof refusalOf, "function", "indexer exports bundleSideRefusal");
  const binding = { jobId: "job", role: "seller", signer: dids[1], nativeAddress: "stor-1" } as BundleBinding;
  const graph = (change: Partial<EvidenceGraph> = {}, bundle: Obj = {}): EvidenceGraph => ({
    profile: "dacs-v0.1", ok: true, bundleContentHash: "a".repeat(64), signaturesVerified: true, refsVerified: false,
    artifacts: [], ratings: [], ...change,
    bundle: { jobId: "job", anchoredByRole: "seller", parties: [{ role: "buyer", primaryClaim: dids[0] }, { role: "seller", primaryClaim: dids[1] }], ...bundle },
  });
  assert.equal(refusalOf(graph(), binding), null);
  assert.equal(refusalOf(graph({ ok: false, reason: "listing reference failed" }), binding), "listing reference failed");
  assert.equal(refusalOf(graph({ ok: false }), binding), "evidence graph failed verification");
  assert.equal(refusalOf(graph({ signaturesVerified: false }), binding), "bundle signatures are not verified");
  assert.equal(refusalOf(graph({}, { jobId: "other" }), binding), "bundle job id does not match the binding");
  assert.equal(refusalOf(graph({}, { anchoredByRole: "buyer" }), binding), "bundle anchoring role does not match the binding role");
  assert.equal(refusalOf(graph({}, { parties: [{ role: "buyer", primaryClaim: dids[0] }] }), binding),
    "bundle role holder is not the binding signer");
  assert.equal(refusalOf(graph({}, { parties: [{ role: "seller", primaryClaim: dids[2] }] }), binding),
    "bundle role holder is not the binding signer");
});
