import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { buildCurrentEvidenceGraph, artifactHash, signedScope } from "../src/catalog/evidenceGraph.js";
import { reconcileCurrentCopies } from "../src/catalog/currentReconciliation.js";
import { isNeutralCancellation } from "../src/catalog/reputation.js";
import { indexRegistration } from "../src/catalog/indexer.js";
import { commitmentProof, fixtureCommitments, signCommitment } from "./fixtures/commitment-proof.js";
import { vector, payeeBoundVector, maps, dids, sign, ref, locator, installAgreement, registeredDeal, bindingFor, type Obj }
  from "./fixtures/current-evidence.js";

type Fixture = Awaited<ReturnType<typeof vector>>;
async function bundles(f: Fixture, change: (scope: Obj, role: "buyer" | "seller") => void, single = false) {
  for (const [role, raw] of [["buyer", f.buyerBundle], ["seller", f.sellerBundle]] as const) {
    const scope = signedScope(raw, "bundle");
    change(scope, role);
    const signatures = await Promise.all((single ? [role === "buyer" ? 0 : 1] : [0, 1]).map(i => sign(scope, "bundle", i, true)));
    const copy = { ...scope, anchoredByRole: role, signatures };
    if (role === "buyer") f.buyerBundle = copy; else f.sellerBundle = copy;
    maps.set(f.locators[role], copy);
  }
}
async function listing(f: Fixture, change: (scope: Obj) => void) {
  const scope = signedScope(f.listing, "listing"); change(scope);
  f.listing = { ...scope, signature: await sign(scope, "listing", 1) }; maps.set(f.locators.listing, f.listing);
  const listingRef = { listingId: "svc", version: 1, contentHash: artifactHash(f.listing, "listing") };
  f.buyerBundle.listingRef = listingRef; f.sellerBundle.listingRef = listingRef;
  await installAgreement(f, { ...signedScope(f.agreement, "agreement"), listingRef });
}
const deps = (f: Fixture, commitment?: typeof fixtureCommitments) => ({ read: async (at: string) => maps.get(at) ?? null,
  resolveListing: async () => ({ raw: f.listing, locator: f.locators.listing }), commitment });
async function abortFixture(payee: boolean, fault: boolean, agreement: boolean, phases: "empty" | "negotiate" | "failed-commit", single: boolean) {
  const f = await (payee ? payeeBoundVector : vector)("precommit", 8100);
  await bundles(f, (scope, role) => {
    if (fault) { delete scope.bundleVersion; scope.faultBundleVersion = "1"; scope.faultedParty = "seller"; }
    scope.outcome = role === "seller" ? "aborted-by-self" : "aborted-by-other";
    if (!agreement) delete scope.agreementRef;
    const pipeline = f.listing.pipeline as Obj[];
    scope.phaseSummary = phases === "empty" ? [] : [{ index: 0, kind: pipeline[0].kind, outcome: "ok" },
      ...(phases === "failed-commit" ? [{ index: 1, kind: pipeline[1].kind, outcome: "fail", errorClass: "permanent" }] : [])];
    scope.settlementEvidence = []; scope.ratingRefs = []; scope.amendments = [];
  }, single);
  return f;
}

function storage(t: TestContext) {
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
    const raw = maps.get(String(url).split("/").pop() ?? "");
    return raw ? Response.json({ success: true, owner: `0x${dids[1].slice(-64)}`, data: raw }) : new Response(null, { status: 404 });
  });
}

async function indexAbort(f: Fixture, commitment?: typeof fixtureCommitments, prior?: Awaited<ReturnType<typeof indexRegistration>>) {
  return indexRegistration({ primaryClaim: dids[1], displayName: "seller", listingAnchors: [f.locators.listing],
    deals: [registeredDeal("precommit", f.locators.buyer, f.locators.seller)], bundleBindings: [
      await bindingFor("precommit", "buyer", f.locators.buyer, f.buyerBundle, 0),
      await bindingFor("precommit", "seller", f.locators.seller, f.sellerBundle, 1),
    ] }, prior, async () => { throw new Error("offline"); }, undefined, undefined, undefined, commitment);
}

for (const payee of [false, true]) for (const fault of [false, true]) for (const single of [false, true])
for (const adapter of [false, true]) for (const [window, validity, eligible] of [
  ["future", { notBefore: 2000, notAfter: 3000 }, false],
  ["expired", { notBefore: 1, notAfter: 149 }, false],
  ["lower boundary", { notBefore: 150, notAfter: 3000 }, true],
  ["upper boundary", { notBefore: 1, notAfter: 150 }, true],
] as const) {
  test(`pre-commit Listing validity ${window}/${payee ? "payee" : "legacy agreement"}/${fault ? "fault" : "bundle"}/${single ? "single" : "both"}/${adapter ? "adapter" : "no adapter"}`, async t => {
    t.mock.method(Date, "now", () => 150);
    storage(t);
    const f = await abortFixture(payee, fault, false, "negotiate", single);
    await listing(f, scope => { scope.validity = { ...validity }; });
    await bundles(f, scope => { delete scope.agreementRef; }, single);
    const forbidden = { resolve: async (): Promise<never> => { throw new Error("must not resolve pre-commit proof"); },
      verifyReceipt: async (): Promise<never> => { throw new Error("must not verify pre-commit receipt"); } };
    const commitment = adapter ? forbidden : undefined;
    for (const role of ["buyer", "seller"] as const) {
      const graph = await buildCurrentEvidenceGraph(f.locators[role], deps(f, commitment));
      assert.equal(graph.ok, true, graph.reason);
      assert.equal(graph.signaturesVerified, true);
      assert.equal(graph.refsVerified, eligible, `${role}: ${graph.reason}`);
      if (!eligible) assert.equal(graph.credit, undefined);
    }
    const record = await indexAbort(f, commitment);
    const repeated = await indexAbort(f, commitment, record);
    for (const result of [record, repeated]) {
      assert.equal(result.listings.length, eligible ? 1 : 0);
      assert.equal(result.deals[0].signatureVerified, true);
      assert.equal(result.deals[0].refsVerified, eligible);
      assert.equal(result.deals[0].reputationEligible, eligible);
      assert.equal(result.reputation.totalAgreements, eligible ? 1 : 0);
      assert.equal(result.reputation.completionRate, null);
      assert.equal(result.reputation.metricsProfile, "TP-1");
    }
  });
}

test("pre-commit replay removes earlier credit after the signed Listing expires", async t => {
  let now = 150;
  t.mock.method(Date, "now", () => now);
  storage(t);
  const f = await abortFixture(false, true, false, "negotiate", true);
  await listing(f, scope => { scope.validity = { notBefore: 1, notAfter: 150 }; });
  await bundles(f, scope => { delete scope.agreementRef; }, true);
  const before = await indexAbort(f);
  assert.equal(before.reputation.totalAgreements, 1);
  now = 151;
  const after = await indexAbort(f, undefined, before);
  assert.equal(after.deals[0].signatureVerified, true);
  assert.equal(after.deals[0].refsVerified, false);
  assert.equal(after.reputation.totalAgreements, 0);
  assert.equal(after.reputation.completionRate, null);
});

for (const payee of [false, true]) for (const fault of [false, true]) for (const agreement of [false, true])
for (const phases of ["empty", "negotiate", "failed-commit"] as const) for (const single of [false, true]) {
  test(`pre-commit ${payee ? "payee" : "legacy agreement"}/${fault ? "fault" : "bundle"}/${agreement ? "agreement" : "no agreement"}/${phases}/${single ? "single" : "both"} checks the commitment boundary`, async () => {
    const f = await abortFixture(payee, fault, agreement, phases, single);
    let calls = 0;
    const forbidden = { resolve: async () => { calls++; throw new Error("must not resolve"); }, verifyReceipt: async () => { calls++; return false; } };
    const buyer = await buildCurrentEvidenceGraph(f.locators.buyer, deps(f, forbidden));
    const seller = await buildCurrentEvidenceGraph(f.locators.seller, deps(f, forbidden));
    const reconciled = reconcileCurrentCopies(registeredDeal("precommit", f.locators.buyer, f.locators.seller), dids[1], buyer, seller);
    const precommit = !agreement && phases !== "failed-commit";
    assert.equal(reconciled.refsVerified, precommit, buyer.reason ?? seller.reason);
    if (precommit) assert.equal(reconciled.sellerOutcome, "aborted-by-self");
    if (precommit || phases === "failed-commit") assert.equal(calls, 0);
    assert.equal((await buildCurrentEvidenceGraph(f.locators.buyer, deps(f))).refsVerified, precommit);
  });
}

for (const payee of [false, true]) for (const fault of [false, true])
test(`pre-commit vet references and neutral cancellation retain denominators (${payee}/${fault})`, async () => {
  const f = await abortFixture(payee, fault, false, "negotiate", true);
  await listing(f, scope => { scope.terms = { cancellationPolicy: "pre-commit" }; });
  const scope: Obj = { recordVersion: "1", jobId: "precommit", evaluatedParty: dids[1], overallDecision: "fail", freshness: [], dealSpecific: [], supplementary: [] };
  const vet = { ...scope, signature: await sign(scope, "composite", 0) }; maps.set(locator(8199), vet);
  await bundles(f, body => { delete body.agreementRef; body.vetRecords = [ref(locator(8199), vet, "composite")]; body.cancellation = { claimedPolicy: "pre-commit" }; }, true);
  const result = await buildCurrentEvidenceGraph(f.locators.seller, deps(f));
  assert.equal(result.refsVerified, true, result.reason);
  assert.equal(result.artifacts.some(a => a.kind === "composite"), true);
  assert.equal(isNeutralCancellation("aborted-by-self", result.bundle.cancellation, result.listing?.terms, result.bundle.phaseSummary), true);
});

for (const [name, change] of [
  ["completion", (s: Obj) => { s.outcome = "completed"; }],
  ["successful legacy commitment", (s: Obj) => { s.phaseSummary = [{ index: 1, kind: "commit-agreement", outcome: "ok" }]; }],
  ["successful payee commitment", (s: Obj) => { s.phaseSummary = [{ index: 1, kind: "commit-payee-bound-agreement", outcome: "ok" }]; }],
  ["later phase", (s: Obj) => { s.phaseSummary = [{ index: 2, kind: "pay-dem", outcome: "ok" }]; }],
  ["wrong phase index", (s: Obj) => { s.phaseSummary = [{ index: 7, kind: "negotiate-fixed-price", outcome: "fail" }]; }],
  ["unknown phase kind", (s: Obj) => { s.phaseSummary = [{ index: 0, kind: "unknown", outcome: "fail" }]; }],
  ["settlement", (s: Obj) => { s.settlementEvidence = [ref(locator(8103), maps.get(locator(8103))!, "evidence")]; }],
  ["rating", (s: Obj) => { s.ratingRefs = [ref(locator(8104), maps.get(locator(8104))!, "rating")]; }],
  ["amendment", (s: Obj) => { s.amendments = [{ arbitrary: true }]; }],
] as const) test(`an agreement-less abort cannot earn credit with ${name}`, async () => {
  const f = await abortFixture(false, false, false, "empty", false);
  await bundles(f, change);
  assert.equal((await buildCurrentEvidenceGraph(f.locators.buyer, deps(f))).refsVerified, false);
});

for (const payee of [false, true]) for (const legacy of [false, true]) {
  test(`sealed-envelope losing bidder is outside ${payee ? "payee" : "legacy agreement"}/${legacy ? "legacy record" : "finality record"} signing roster`, async () => {
    const f = await (payee ? payeeBoundVector : vector)("sealed", 8200);
    await listing(f, scope => { (scope.pipeline as Obj[])[0] = { kind: "negotiate-sealed-envelope",
      parameters: { commitDeadline: 1, revealWindow: 3600, selectionRule: "lowest-price" } };
      scope.pricing = { kind: "auction", selectionRule: "lowest-price" }; });
    await installAgreement(f, { ...signedScope(f.agreement, "agreement"), derivedFromPattern: "sealed-envelope",
      parties: [...f.agreement.parties as Obj[], { role: "bidder-non-winning", primaryClaim: dids[2] }] });
    const proof = commitmentProof(f.agreement, f.agreement.listingRef as Obj, 90, legacy);
    proof.record.parties = [dids[0], dids[1]]; signCommitment(proof);
    const verifier = { ...fixtureCommitments, resolve: async () => proof };
    const result = await buildCurrentEvidenceGraph(f.locators.buyer, deps(f, verifier));
    assert.equal(result.refsVerified, true, result.reason);
    for (const roster of [[dids[0]], [dids[0], dids[1], dids[2]], [dids[0], dids[0]], [dids[0], dids[1], dids[1]]]) {
      proof.record.parties = roster; signCommitment(proof);
      assert.equal((await buildCurrentEvidenceGraph(f.locators.buyer, deps(f, verifier))).refsVerified, false);
    }
  });
}

test("missing proof preserves authenticated hash, artifacts and catalog signature standing", async t => {
  const f = await vector("signature-only", 8300);
  const result = await buildCurrentEvidenceGraph(f.locators.buyer, deps(f));
  assert.equal(result.ok, true);
  assert.equal(result.signaturesVerified, true);
  assert.equal(result.bundleContentHash, artifactHash(f.buyerBundle, "bundle"));
  assert.equal(result.artifacts.some(a => a.kind === "agreement"), true);
  assert.equal(result.refsVerified, false);
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
    const raw = maps.get(String(url).split("/").pop() ?? "");
    return raw ? Response.json({ success: true, owner: `0x${dids[1].slice(-64)}`, data: raw }) : new Response(null, { status: 404 });
  });
  const record = await indexRegistration({ primaryClaim: dids[1], displayName: "seller", listingAnchors: [f.locators.listing],
    deals: [registeredDeal("signature-only", f.locators.buyer, f.locators.seller)], bundleBindings: [
      await bindingFor("signature-only", "buyer", f.locators.buyer, f.buyerBundle, 0), await bindingFor("signature-only", "seller", f.locators.seller, f.sellerBundle, 1),
    ] }, undefined, async () => { throw new Error("offline"); });
  assert.equal(record.deals[0].signatureVerified, true);
  assert.equal(record.deals[0].refsVerified, false);
  assert.equal(record.deals[0].ratings?.length ?? 0, 0);
  assert.equal(record.reputation.completed, 0);
  assert.deepEqual(record.reputation.observedTransactionalVolume, []);
});

test("each copy needs its own proof and the exact same authenticated commitment context", async () => {
  const f = await vector("copies", 8400);
  const proof = commitmentProof(f.agreement, f.agreement.listingRef as Obj);
  const buyer = await buildCurrentEvidenceGraph(f.locators.buyer, deps(f, { ...fixtureCommitments, resolve: async () => proof }));
  const sellerWithout = await buildCurrentEvidenceGraph(f.locators.seller, deps(f));
  const deal = registeredDeal("copies", f.locators.buyer, f.locators.seller);
  assert.equal(reconcileCurrentCopies(deal, dids[1], buyer, sellerWithout).refsVerified, false);
  await installAgreement(f, { ...signedScope(f.agreement, "agreement"), terms: { ...(f.agreement.terms as Obj), deadline: 999 } });
  const other = commitmentProof(f.agreement, f.agreement.listingRef as Obj);
  const sellerDifferent = await buildCurrentEvidenceGraph(f.locators.seller, deps(f, { ...fixtureCommitments, resolve: async () => other }));
  assert.equal(buyer.refsVerified, true, buyer.reason);
  assert.equal(sellerDifferent.refsVerified, true, sellerDifferent.reason);
  assert.equal(reconcileCurrentCopies(deal, dids[1], buyer, sellerDifferent).refsVerified, false);
});

test("one completed deal plus one seller-fault pre-commit abort counts two agreements without a rate under TP-1", async t => {
  t.mock.method(Date, "now", () => 150);
  const aborted = await abortFixture(false, true, false, "negotiate", true);
  const saved = new Map(maps);
  const completed = await vector("completed", 8500);
  for (const [at, raw] of saved) maps.set(at, raw);
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
    const raw = maps.get(String(url).split("/").pop() ?? "");
    return raw ? Response.json({ success: true, owner: `0x${dids[1].slice(-64)}`, data: raw }) : new Response(null, { status: 404 });
  });
  const fixtures = [aborted, completed];
  const bindings = await Promise.all(fixtures.flatMap(f => [
    bindingFor(String(f.buyerBundle.jobId), "buyer", f.locators.buyer, f.buyerBundle, 0),
    bindingFor(String(f.sellerBundle.jobId), "seller", f.locators.seller, f.sellerBundle, 1),
  ]));
  const record = await indexRegistration({ primaryClaim: dids[1], displayName: "seller", listingAnchors: fixtures.map(f => f.locators.listing),
    deals: fixtures.map(f => registeredDeal(String(f.buyerBundle.jobId), f.locators.buyer, f.locators.seller)), bundleBindings: bindings },
    undefined, async () => { throw new Error("offline"); }, undefined, undefined, undefined,
    { ...fixtureCommitments, resolve: async () => commitmentProof(completed.agreement, completed.agreement.listingRef as Obj) });
  assert.equal(record.reputation.completionRate, null);
  assert.equal(record.reputation.totalAgreements, 2);
});

test("pre-commit invalid signatures and conflicting terminal copies cannot earn credit", async () => {
  const f = await abortFixture(false, true, false, "negotiate", true);
  const buyer = await buildCurrentEvidenceGraph(f.locators.buyer, deps(f));
  await bundles(f, (scope, role) => { if (role === "seller") { scope.outcome = "aborted-by-other"; scope.faultedParty = "buyer"; } }, true);
  const seller = await buildCurrentEvidenceGraph(f.locators.seller, deps(f));
  assert.equal(reconcileCurrentCopies(registeredDeal("precommit", f.locators.buyer, f.locators.seller), dids[1], buyer, seller).refsVerified, false);
  maps.set(f.locators.buyer, { ...f.buyerBundle, signatures: [] });
  assert.equal((await buildCurrentEvidenceGraph(f.locators.buyer, deps(f))).refsVerified, false);
});

for (const payee of [false, true]) test(`an agreement-bearing abort uses authenticated commitment proof (${payee})`, async () => {
  const f = await abortFixture(payee, false, true, "negotiate", false);
  const proof = commitmentProof(f.agreement, f.agreement.listingRef as Obj);
  let calls = 0;
  const verifier = { ...fixtureCommitments, resolve: async () => { calls++; return proof; } };
  const buyer = await buildCurrentEvidenceGraph(f.locators.buyer, deps(f, verifier));
  const seller = await buildCurrentEvidenceGraph(f.locators.seller, deps(f, verifier));
  assert.equal(buyer.refsVerified, true, buyer.reason); assert.equal(seller.refsVerified, true, seller.reason);
  assert.equal(calls, 2, "agreement-bearing copies each qualify their own commitment");
});
