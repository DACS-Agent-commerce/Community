import { authorityProof, authoritySigner, proofHash, verifyTestAuthority } from "./helpers/authority.js";
import { nativeNodeFixture } from "./helpers/native-node.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { canonicalize, contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";

// The indexer resolves each side of a current-profile deal only through BundleBindings its own
// role holder signed (DACS-5 BB-5..BB-7), and reports the deal unverified otherwise.
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-indexer-binding-rules-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
const { indexRegistration } = await import("../src/catalog/indexer.js");
const { artifactHash, buildCurrentEvidenceGraph, paymentTxRefsOk, signedScope } = await import("../src/catalog/evidenceGraph.js");
const { bundleBindingOverflowKey, logicalBundleAddress } = await import("../src/catalog/bundleBinding.js");
const { loadScanState, saveScanState, loadCatalog } = await import("../src/catalog/store.js");
const { verifyIdentityPresentation } = await import("../src/catalog/listingVerification.js");
const { resolveDemosPrimaryClaimKey } = await import("../src/catalog/primaryClaimKey.js");
const { fullSignatureStanding } = await import("../src/catalog/bundleSignerPolicy.js");
const { ANCHOR_BINDING_DOMAIN, deliverableLogicalAddress, paymentLogicalAddress } = await import("../src/catalog/anchorBinding.js");
const { OPAQUE_PROGRAM_NAME } = await import("./helpers/anchor-binding.js");
const { VerificationUnavailable } = await import("../src/catalog/verificationUnavailable.js");
test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));

type Obj = Record<string, unknown>;
const seeds = [101, 102, 103].map((byte) => Uint8Array.from(Buffer.alloc(32, byte)));
const dids = seeds.map((seed) => `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`);
const [BUYER, SELLER, OUTSIDER] = [0, 1, 2];
const at = (n: number) => `stor-${(0xe000 + n).toString(16).padStart(40, "0")}`;
const JOB = "indexer-binding-job";
const value = (message: string, signer: number) =>
  Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKeyFromSeed(seeds[signer]))).toString("base64url");
const PREFIX: Record<string, string> = { listing: "dacs-listing:v1:", agreement: "dacs-agreement:v1:", evidence: "dacs-evidence:v1:", rating: "dacs-rating:v1:", composite: "dacs-composite:v1:", "verify-result": "dacs-verifyresult:v1:", bundle: "dacs-bundle:v1:" };
const signedWith = (raw: Obj, kind: "listing" | "agreement" | "evidence" | "rating" | "composite" | "verify-result" | "bundle", signer: number, field = "signer") =>
  ({ [field]: dids[signer], algorithm: "ed25519", value: value(PREFIX[kind] + artifactHash(raw, kind), signer) });
const refTo = (locator: string, raw: Obj, kind: "agreement" | "evidence" | "rating" | "composite" | "verify-result") => ({ anchor: { kind: "storage-program", locator }, contentHash: artifactHash(raw, kind) });

const store = new Map<string, Obj>();
const identity: Obj = { bundleVersion: "1", presentedBy: dids[SELLER], presentedAt: 1, claims: [{ ref: dids[SELLER] }] };
const listingScope: Obj = {
  dacsVersion: "1", listingVersion: 1, listingId: "binding-rules", requiredCapabilities: ["SR-2"],
  seller: { identity: { ...identity, presentation: { kind: "per-claim", signatures: [{ ref: dids[SELLER],
    signature: Buffer.from(ed25519Sign(Buffer.from(`dacs-bundle-presentation:v1:${contentHash(identity)}`), privateKeyFromSeed(seeds[SELLER]))).toString("hex") }] } }, displayName: "seller" },
  offering: { title: "rules", description: "rules", category: "rules.binding", tags: [], deliverable: { kind: "storage-program", accessModel: "public" } },
  buyerRequirement: { requirementVersion: "1", required: [] },
  pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }, { kind: "deliver-storage-program" }],
  pricing: { kind: "fixed", price: { amount: "2", currency: "DEM" } }, acceptedRails: [{ railId: "demos-native:DEM" }], terms: {}, validity: { notBefore: 1 },
};
const listing = { ...listingScope, signature: signedWith(listingScope, "listing", SELLER) };
const listingRef = { listingId: "binding-rules", version: 1, contentHash: artifactHash(listing, "listing") };
const agreementScope: Obj = { agreementVersion: "1", jobId: JOB, listingRef, derivedFromPattern: "fixed-price",
  parties: [{ role: "buyer", primaryClaim: dids[BUYER] }, { role: "seller", primaryClaim: dids[SELLER] }],
  terms: { price: { amount: "2", currency: "DEM" }, rail: { railId: "demos-native:DEM" }, deliverable: { deliverableType: "storage-program", hash: contentHash({ kind: "storage-program", accessModel: "public" }) } } };
const agreement = { ...agreementScope, signatures: [signedWith(agreementScope, "agreement", BUYER, "party"), signedWith(agreementScope, "agreement", SELLER, "party")] };
const evidenceScope: Obj = { evidenceVersion: "1", jobId: JOB, phase: "pay-dem", outcome: "success", paymentTxRefs: [{ kind: "demos", blockNumber: 1, txHash: `0x${"AB".repeat(32)}` }],
  paymentAmount: { amount: "2", currency: "DEM" }, settlementFinality: { model: "bft-final", finalityObservedAt: 100 }, observedAt: 100 };
const evidence = { ...evidenceScope, signature: signedWith(evidenceScope, "evidence", SELLER) };
const ratingScope: Obj = { ratingVersion: "1", jobId: JOB, rater: dids[BUYER], target: dids[SELLER], targetRole: "seller", value: 4, ratedAt: 110 };
const rating = { ...ratingScope, signature: signedWith(ratingScope, "rating", BUYER) };
const payload = { report: "fixture delivery" };
const deliveryScope: Obj = { evidenceVersion: "1", jobId: JOB, phase: "deliver-storage-program", outcome: "success", observedAt: 101,
  deliverableContentHash: contentHash(payload), deliverableAnchor: { kind: "storage-program", locator: at(61) } };
const delivery = { ...deliveryScope, signature: signedWith(deliveryScope, "evidence", SELLER) };
store.set(at(60), delivery).set(at(61), payload);
store.set(at(1), listing).set(at(2), agreement).set(at(3), evidence).set(at(4), rating);
const bundleScope = (change: Obj = {}): Obj => ({
  bundleVersion: "1", jobId: JOB, outcome: "completed", listingRef, agreementRef: refTo(at(2), agreement, "agreement"),
  parties: [{ role: "buyer", bundleHash: "a".repeat(64), primaryClaim: dids[BUYER] }, { role: "seller", bundleHash: "b".repeat(64), primaryClaim: dids[SELLER] }],
  phaseSummary: [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" }, { index: 2, kind: "pay-dem", outcome: "ok" }, { index: 3, kind: "deliver-storage-program", outcome: "ok" }], vetRecords: [], settlementEvidence: [refTo(at(3), evidence, "evidence"), refTo(at(60), delivery, "evidence")],
  ratingRefs: [refTo(at(4), rating, "rating")], recipeRegistryVersion: 1, railRegistryVersion: 1, finalisedAt: 120, ...change,
});
/** A signed AnchorBinding: the anchoring party binds a native settlement anchor to its logical address. */
const anchorBinding = (jobId: string, logicalAddress: string, nativeAddress: string, hash: string, signer: number): Obj => {
  const scope: Obj = { anchorBindingVersion: "1", jobId, logicalAddress, nativeAddress, contentHash: hash, signer: dids[signer] };
  return { ...scope, signature: { algorithm: "ed25519", signer: dids[signer], value: value(ANCHOR_BINDING_DOMAIN + contentHash(scope), signer) } };
};
/** The bindings a conforming publisher carries: each evidence signer binds its payment record to the
 * PC-2 address of its phase (by pointer, else the only entry of its kind) and its storage payload to the job. */
function anchorBindingsFor(scope: Obj): Obj[] {
  const phases = Array.isArray(scope.phaseSummary) ? scope.phaseSummary as Obj[] : [];
  const pipeline = (store.get(at(1))?.pipeline ?? []) as Obj[];
  const jobId = String(scope.jobId);
  return (Array.isArray(scope.settlementEvidence) ? scope.settlementEvidence as Obj[] : []).flatMap((ref) => {
    const locator = String((ref?.anchor as Obj | undefined)?.locator);
    const evidence = store.get(locator);
    const signer = dids.indexOf(String((evidence?.signature as Obj | undefined)?.signer));
    if (!evidence || signer < 0) return [];
    if (String(evidence.phase).startsWith("pay-")) {
      const same = phases.filter((phase) => phase.kind === evidence.phase);
      const phase = phases.find((entry) => ((entry.attestationRef as Obj | undefined)?.anchor as Obj | undefined)?.locator === locator) ??
        (same.length === 1 ? same[0] : undefined);
      const index = Number(phase?.index ?? 2);
      const rail = String((pipeline[index]?.parameters as Obj | undefined)?.rail ?? "demos-native:DEM");
      return [anchorBinding(jobId, paymentLogicalAddress(jobId, rail, index), locator, String(ref.contentHash), signer)];
    }
    const payloadAt = (evidence.deliverableAnchor as Obj | undefined)?.locator;
    return evidence.phase === "deliver-storage-program" && typeof payloadAt === "string" && typeof evidence.deliverableContentHash === "string"
      ? [anchorBinding(jobId, deliverableLogicalAddress(jobId), payloadAt, evidence.deliverableContentHash, signer)] : [];
  });
}
// Directory-profile tooling always carries the signed anchorBindings member, empty when nothing is bound.
const copy = (anchoredByRole: string, scope = bundleScope(), signers = [BUYER, SELLER]) => {
  const carried = scope.anchorBindings === undefined ? { ...scope, anchorBindings: anchorBindingsFor(scope) } : scope;
  return { ...carried, signatures: signers.map((signer) => signedWith(carried, "bundle", signer, "party")), anchoredByRole };
};
store.set(at(5), copy("buyer")).set(at(6), copy("seller"));
store.set(at(7), copy("seller", bundleScope({ jobId: "another-job" })));
store.set(at(8), copy("seller", bundleScope(), [SELLER]));

function binding(role: "buyer" | "seller", nativeAddress: string, signer: number, change: Obj = {}): Obj {
  const scope: Obj = { bindingVersion: "1", jobId: JOB, role, logicalAddress: logicalBundleAddress(JOB, role), nativeAddress,
    bundleContentHash: artifactHash(store.get(nativeAddress) ?? {}, "bundle"), signer: dids[signer], ...change };
  return { ...scope, signature: { algorithm: "ed25519", signer: dids[signer], value: value(`dacs-bundle-binding:v1:${contentHash(scope)}`, signer) } };
}

async function index(bindings: Obj[], overflow: string[] = []) {
  return (await indexSeller(bindings, overflow)).deals[0];
}

async function indexSeller(bindings: Obj[], overflow: string[] = [], rail = "demos-native:DEM", metadata: Record<string, Obj> = {}, nodeRead = nativeNodeFixture(() => store.values())) {
  const state = loadScanState();
  state.bundleBindingOverflow = overflow;
  saveScanState(state);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") {
      const call = JSON.parse(String(init.body)).params?.[0];
      if (["getTxByHash", "getBlockByNumber"].includes(call?.message)) return Response.json({ result: 200, response: await nodeRead(call.message, call.data) });
    }
    const locator = String(input).split("/").pop() ?? "";
    const data = store.get(locator);
    if (metadata[locator]?.unreadable) return Response.json({ success: false, errorCode: "PERMISSION_DENIED" }, { status: 403 });
    return data ? Response.json({ success: true, owner: `0x${dids[SELLER].slice(-64)}`, acl: { mode: "public" }, programName: OPAQUE_PROGRAM_NAME, data, ...metadata[locator] }) : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
  };
  try {
    const record = await indexRegistration({ primaryClaim: dids[SELLER], displayName: "seller", listingAnchors: [at(1)],
      deals: [{ jobId: JOB, rail, buyerBundleRef: at(90), sellerBundleRef: at(91), owners: { buyer: dids[BUYER], seller: dids[SELLER] } }],
      bundleBindings: bindings as never }, undefined, async () => { throw new Error("identity unavailable"); });
    return record;
  } finally {
    globalThis.fetch = originalFetch;
  }
}
const holders = () => [binding("buyer", at(5), BUYER), binding("seller", at(6), SELLER)];

test("a deal resolved through its holders' bindings carries the authoritative copy's verdicts", async () => {
  const deal = await index(holders());
  assert.equal(deal.refsVerified, true);
  assert.equal(deal.signatureVerified, true);
  assert.equal(deal.reputationEligible, true);
  assert.equal(deal.buyerBundleRef, at(5));
  assert.equal(deal.sellerBundleRef, at(6));
  assert.equal(deal.anchoredByRole, "seller");
  assert.equal(deal.sellerOutcome, "completed");
  assert.equal(deal.fullSignatureStanding, true);
  assert.equal(deal.rail, "demos-native:DEM");
  assert.equal(deal.category, "rules.binding");
  assert.equal(deal.finalisedAt, 120);
  assert.deepEqual(deal.agreementPrice, { amount: "2", currency: "DEM" });
  // SB-1: the key is the canonical demos:{lower-case hash without 0x}, and the phase index is the bundle entry's.
  assert.deepEqual(deal.settlementTxIds, [{ id: `demos:${"ab".repeat(32)}`, observedAt: 100, phaseIndex: 2, evidenceHash: artifactHash(evidence, "evidence"), nodeVerified: true }]);
  assert.deepEqual(deal.ratings, [{ rater: dids[BUYER], target: dids[SELLER], targetRole: "seller", value: 4, ratedAt: 110, contentHash: artifactHash(rating, "rating") }]);
  assert.equal(deal.cancellationNeutral, false);
});

test("a side resolves only from a valid binding its role holder signed for this job, role and copy", async () => {
  const verdict = async (bindings: Obj[], overflow: string[] = []) => {
    const deal = await index(bindings, overflow);
    return `${deal.refsVerified ? "verified" : "unverified"} ${deal.sellerBundleRef}`;
  };
  const [buyerSide, sellerSide] = holders();
  assert.deepEqual({
    "an outsider's binding beside the holders'": await verdict([...holders(), binding("seller", at(7), OUTSIDER)]),
    "no seller binding": await verdict([buyerSide]),
    "a seller binding signed by the buyer": await verdict([buyerSide, binding("seller", at(6), BUYER)]),
    "a seller binding signed by an outsider": await verdict([buyerSide, binding("seller", at(6), OUTSIDER)]),
    "a seller binding to the buyer's copy": await verdict([buyerSide, binding("seller", at(5), SELLER)]),
    "a seller binding to another job's copy": await verdict([buyerSide, binding("seller", at(7), SELLER)]),
    "a seller binding with another content hash": await verdict([buyerSide, binding("seller", at(6), SELLER, { bundleContentHash: "0".repeat(64) })]),
    "a seller binding for another job": await verdict([buyerSide, binding("seller", at(6), SELLER, { jobId: "another-job", logicalAddress: logicalBundleAddress("another-job", "seller") })]),
    "a seller binding whose signature fails": await verdict([buyerSide, { ...sellerSide, nativeAddress: at(8) }]),
    "the seller's sticky overflow": await verdict(holders(), [bundleBindingOverflowKey(JOB, "seller", dids[SELLER])]),
    "another signer's overflow": await verdict(holders(), [bundleBindingOverflowKey(JOB, "seller", dids[OUTSIDER])]),
    "a seller copy signed by the seller alone": await verdict([buyerSide, binding("seller", at(8), SELLER)]),
  }, {
    "an outsider's binding beside the holders'": `verified ${at(6)}`,
    "no seller binding": `unverified ${at(91)}`,
    "a seller binding signed by the buyer": `unverified ${at(91)}`,
    "a seller binding signed by an outsider": `unverified ${at(91)}`,
    "a seller binding to the buyer's copy": `unverified ${at(91)}`,
    "a seller binding to another job's copy": `unverified ${at(91)}`,
    "a seller binding with another content hash": `unverified ${at(91)}`,
    "a seller binding for another job": `unverified ${at(91)}`,
    "a seller binding whose signature fails": `unverified ${at(91)}`,
    "the seller's sticky overflow": `unverified ${at(91)}`,
    "another signer's overflow": `verified ${at(6)}`,
    "a seller copy signed by the seller alone": `unverified ${at(91)}`,
  });
  // Copies that contradict on outcome are no authoritative pair: each side resolves, the deal does not count.
  store.set(at(9), copy("seller", bundleScope({ outcome: "failed-perm" })));
  const divergent = await index([buyerSide, binding("seller", at(9), SELLER)]);
  assert.equal(divergent.refsVerified, false);
  assert.equal(divergent.reputationEligible, false);
  // An advisory difference is not a contradiction.
  store.set(at(10), copy("seller", bundleScope({ finalisedAt: 121 })));
  assert.equal((await index([buyerSide, binding("seller", at(10), SELLER)])).refsVerified, true);
  // The registration's own stale pointers never stand in for a resolved copy.
  assert.equal((await index(holders())).buyerBundleRef, at(5));
  assert.equal(signedScope(copy("buyer"), "bundle").anchoredByRole, undefined);
});

test("§10.4.1 full standing needs every declared party, a distinct orchestrator included, and the authoritative copy's is recorded", async () => {
  const parties = (orchestrator?: string) => [{ role: "buyer", primaryClaim: dids[BUYER] }, { role: "seller", primaryClaim: dids[SELLER] },
    ...(orchestrator ? [{ role: "orchestrator", primaryClaim: orchestrator }] : [])];
  assert.equal(fullSignatureStanding(parties(), [dids[BUYER], dids[SELLER]]), true);
  assert.equal(fullSignatureStanding(parties(), [dids[SELLER]]), false);
  assert.equal(fullSignatureStanding(parties(dids[OUTSIDER]), [dids[BUYER], dids[SELLER]]), false, "a distinct orchestrator must sign too");
  assert.equal(fullSignatureStanding(parties(dids[OUTSIDER]), [dids[BUYER], dids[SELLER], dids[OUTSIDER]]), true);
  assert.equal(fullSignatureStanding(parties(dids[BUYER]), [dids[BUYER], dids[SELLER]]), true, "an orchestrator who is also the buyer adds no signer");
  assert.equal(fullSignatureStanding([{ role: "buyer", primaryClaim: dids[BUYER] }], [dids[BUYER]]), false);
  // An asymmetric abort pair: the seller's own copy is authoritative, so its standing is the one recorded.
  const aborted = (outcome: string) => { const scope = bundleScope({ outcome }); delete scope.agreementRef; scope.settlementEvidence = []; scope.phaseSummary = []; return scope; };
  store.set(at(13), copy("buyer", aborted("aborted-by-self"), [BUYER]));
  store.set(at(14), copy("seller", aborted("aborted-by-other"), [BUYER, SELLER]));
  const sellerFull = await index([binding("buyer", at(13), BUYER), binding("seller", at(14), SELLER)]);
  assert.deepEqual([sellerFull.refsVerified, sellerFull.anchoredByRole, sellerFull.fullSignatureStanding], [true, "seller", true]);
  store.set(at(15), copy("buyer", aborted("aborted-by-self"), [BUYER, SELLER]));
  store.set(at(16), copy("seller", aborted("aborted-by-other"), [SELLER]));
  const sellerLesser = await index([binding("buyer", at(15), BUYER), binding("seller", at(16), SELLER)]);
  assert.deepEqual([sellerLesser.refsVerified, sellerLesser.anchoredByRole, sellerLesser.fullSignatureStanding], [true, "seller", false]);
});

test("a session aborted before commitment verifies with each copy signed by its anchor alone, without full standing", async () => {
  const aborted = (outcome: string) => { const scope = bundleScope({ outcome }); delete scope.agreementRef; scope.settlementEvidence = []; scope.phaseSummary = []; return scope; };
  store.set(at(11), copy("buyer", aborted("aborted-by-self"), [BUYER]));
  store.set(at(12), copy("seller", aborted("aborted-by-other"), [SELLER]));
  const deal = await index([binding("buyer", at(11), BUYER), binding("seller", at(12), SELLER)]);
  assert.equal(deal.refsVerified, true);
  assert.equal(deal.fullSignatureStanding, false);
  assert.equal(deal.sellerOutcome, "aborted-by-other");
  assert.equal(deal.outcome, "aborted-by-other");
  assert.equal(deal.anchoredByRole, "seller");
});

test("SIG-4 AnchorBinding signatures cover the dacs-x-anchor-binding:v1 domain bytes", async () => {
  const { boundLogicalAddress, verifyAnchorBinding, verifyAnchorBindings } = await import("../src/catalog/anchorBinding.js");
  const scope: Obj = { anchorBindingVersion: "1", jobId: JOB, logicalAddress: deliverableLogicalAddress(JOB), nativeAddress: at(61),
    contentHash: contentHash(payload), signer: dids[SELLER] };
  const signedOver = (message: string) => ({ ...scope, signature: { algorithm: "ed25519", signer: dids[SELLER], value: value(message, SELLER) } });
  // The domain is spelled out rather than imported, so the signed bytes themselves are pinned.
  const domainSeparated = signedOver(`dacs-x-anchor-binding:v1:${contentHash(scope)}`);
  const bare = signedOver(contentHash(scope));
  assert.notEqual(await verifyAnchorBinding(domainSeparated), null);
  assert.equal(await verifyAnchorBinding(bare), null);
  assert.equal(await verifyAnchorBinding(signedOver(`dacs-bundle-binding:v1:${contentHash(scope)}`)), null);
  const anchor = { nativeAddress: at(61), contentHash: contentHash(payload), signer: dids[SELLER] };
  assert.equal(boundLogicalAddress((await verifyAnchorBindings([domainSeparated], JOB))!, anchor), deliverableLogicalAddress(JOB));
  assert.equal(await verifyAnchorBindings([bare], JOB), null);
  // Structural limits hold for an otherwise correctly signed binding.
  const signedScope = (change: Obj) => { const body = { ...scope, ...change };
    return { ...body, signature: { algorithm: "ed25519", signer: dids[SELLER], value: value(`dacs-x-anchor-binding:v1:${contentHash(body)}`, SELLER) } }; };
  assert.notEqual(await verifyAnchorBinding(signedScope({})), null);
  for (const change of [{ anchorBindingVersion: "2" }, { jobId: "j".repeat(161) }, { padding: "p".repeat(16 * 1024) }]) {
    assert.equal(await verifyAnchorBinding(signedScope(change)), null, Object.keys(change)[0]);
  }
  // SIG-5: an unknown member stays in the signed scope, so dropping or adding one after signing breaks it.
  const extended = signedScope({ note: "carried" });
  assert.notEqual(await verifyAnchorBinding(extended), null);
  const withoutNote: Obj = { ...extended }; delete withoutNote.note;
  assert.equal(await verifyAnchorBinding(withoutNote), null);
  assert.equal(await verifyAnchorBinding({ ...signedScope({}), note: "added later" }), null);
  // The content hash omits `signatures` too, so that member could be added unsigned (review sweep 10, P3-7).
  assert.equal(contentHash({ ...scope, signatures: ["unsigned"] }), contentHash(scope));
  assert.equal(await verifyAnchorBinding({ ...signedScope({}), signatures: ["unsigned"] }), null);
  // SIG-6: only the strict unpadded base64url value of the same signature bytes is accepted.
  const strict = signedScope({});
  const bytes = Buffer.from(String((strict.signature as Obj).value), "base64url");
  for (const encoded of [`${bytes.toString("base64url")}==`, bytes.toString("base64"), bytes.toString("hex")]) {
    assert.equal(await verifyAnchorBinding({ ...strict, signature: { ...strict.signature as Obj, value: encoded } }), null, encoded);
  }
});

test("a carried anchorBindings member is judged whole, and an anchor sees only its own signer's bindings", async () => {
  const { boundLogicalAddress, verifyAnchorBindings } = await import("../src/catalog/anchorBinding.js");
  const PAID = paymentLogicalAddress(JOB, "demos-native:DEM", 2), HASH = "c".repeat(64);
  const sellerPaid = anchorBinding(JOB, PAID, at(3), HASH, SELLER);
  // Every entry must authenticate and bind one of this job's addresses, wherever it points.
  assert.equal((await verifyAnchorBindings([], JOB))!.length, 0);
  assert.equal((await verifyAnchorBindings([sellerPaid, anchorBinding(JOB, deliverableLogicalAddress(JOB), at(98), HASH, OUTSIDER)], JOB))!.length, 2);
  const refused: Record<string, Obj> = {
    "an entry changed after signing": { ...anchorBinding(JOB, PAID, at(98), HASH, SELLER), anchorTx: "ab".repeat(32) },
    "a binding for another job": anchorBinding("another-job", paymentLogicalAddress("another-job", "demos-native:DEM", 2), at(98), HASH, SELLER),
    "another job's payment address": anchorBinding(JOB, paymentLogicalAddress("another-job", "demos-native:DEM", 2), at(98), HASH, SELLER),
    "another job's deliverable address": anchorBinding(JOB, deliverableLogicalAddress("another-job"), at(98), HASH, SELLER),
    "an address that is neither": anchorBinding(JOB, `dacs4:listing:${JOB}`, at(98), HASH, SELLER),
  };
  for (const [name, entry] of Object.entries(refused)) assert.equal(await verifyAnchorBindings([sellerPaid, entry], JOB), null, name);
  // undefined: the anchor's signer bound nothing there. null: what it bound contradicts the record it signed.
  const lookup = async (entries: Obj[]) =>
    boundLogicalAddress((await verifyAnchorBindings(entries, JOB))!, { nativeAddress: at(3), contentHash: HASH, signer: dids[SELLER] });
  assert.equal(await lookup([]), undefined);
  assert.equal(await lookup([sellerPaid]), PAID);
  assert.equal(await lookup([sellerPaid, sellerPaid]), PAID);
  assert.equal(await lookup([anchorBinding(JOB, PAID, at(3), HASH, BUYER), anchorBinding(JOB, PAID, at(3), HASH, OUTSIDER)]), undefined, "others' bindings are inert");
  assert.equal(await lookup([anchorBinding(JOB, PAID, at(98), HASH, SELLER)]), undefined, "a binding of another anchor");
  assert.equal(await lookup([anchorBinding(JOB, PAID, at(3), "d".repeat(64), SELLER)]), null, "another content hash");
  assert.equal(await lookup([sellerPaid, anchorBinding(JOB, paymentLogicalAddress(JOB, "demos-native:DEM", 3), at(3), HASH, SELLER)]), null, "two addresses");
  assert.equal(await lookup([sellerPaid, anchorBinding(JOB, PAID, at(3), "d".repeat(64), SELLER)]), null, "one of two for another hash");
});

test("a completed deal with no pay phase or evidence never contributes reputation (review probe P4)", async () => {
  const bare = bundleScope({ phaseSummary: [], settlementEvidence: [] });
  store.set(at(20), copy("buyer", bare)).set(at(21), copy("seller", bare));
  const deal = await index([binding("buyer", at(20), BUYER), binding("seller", at(21), SELLER)]);
  assert.equal(deal.refsVerified, false);
  assert.equal(deal.reputationEligible, false);
});

const FAILED_MANDATORY_PHASE = "completed session contains a failed mandatory phase";
/** Publishes `pipeline` and a both-signed completed session over it whose phase entries carry `outcomes`
 * (default ok); each settle phase cites `evidenceAt[index]`, else the fixture success evidence, or `at(30)` when it failed. */
function failedPhaseSession(pipeline: Obj[], outcomes: Record<number, string>, evidenceAt: Record<number, Obj> = {}) {
  const listedScope = { ...listingScope, pipeline };
  const listed = { ...listedScope, signature: signedWith(listedScope, "listing", SELLER) };
  store.set(at(1), listed);
  const listingRef = { ...bundleScope().listingRef as Obj, contentHash: artifactHash(listed, "listing") };
  const agreedScope = { ...agreementScope, listingRef };
  const agreed = { ...agreedScope, signatures: [signedWith(agreedScope, "agreement", BUYER, "party"), signedWith(agreedScope, "agreement", SELLER, "party")] };
  store.set(at(2), agreed);
  const phaseSummary = pipeline.map((phase, index) => outcomes[index] === "fail"
    ? { index, kind: phase.kind, outcome: "fail", errorClass: "permanent" } : { index, kind: phase.kind, outcome: "ok" });
  const settlementEvidence = phaseSummary.flatMap((phase): Obj[] => {
    if (evidenceAt[phase.index]) return [evidenceAt[phase.index]];
    if (phase.outcome === "fail") return /^(pay|deliver)-/.test(String(phase.kind)) ? [refTo(at(30), store.get(at(30))!, "evidence")] : [];
    if (phase.kind === "pay-dem") return [refTo(at(3), evidence, "evidence")];
    return phase.kind === "deliver-storage-program" ? [refTo(at(60), delivery, "evidence")] : [];
  });
  const scope = bundleScope({ listingRef, agreementRef: refTo(at(2), agreed, "agreement"), phaseSummary, settlementEvidence });
  store.set(at(20), copy("buyer", scope)).set(at(21), copy("seller", scope));
  return buildCurrentEvidenceGraph(at(20), {
    readSettlementNode: nativeNodeFixture(() => store.values()),
    read: async (locator) => store.get(locator) ?? null,
    readAnchorRecord: async (locator) => ({ data: store.get(locator)!, acl: { mode: "public" }, programName: OPAQUE_PROGRAM_NAME }),
    resolveListing: async () => ({ locator: at(1), raw: listed }),
  });
}
const failedEvidence = (phase: string) => {
  const scope: Obj = { evidenceVersion: "1", jobId: JOB, phase, outcome: "failure", observedAt: 100 };
  return { ...scope, signature: signedWith(scope, "evidence", SELLER) };
};

test("completed sessions reject failed mandatory phases and retain the non-fatal rate exception", async () => {
  const original = new Map(store);
  // Every listed phase has an entry and only `kind` fails, so ST-2 itself decides each case. A failed
  // commit carrying an agreement is refused by its own earlier rule.
  const expected: Record<string, string | undefined> = {
    "pay-dem": FAILED_MANDATORY_PHASE, "deliver-storage-program": FAILED_MANDATORY_PHASE, "deliver-entitlement": FAILED_MANDATORY_PHASE,
    "deliver-attested-payload": FAILED_MANDATORY_PHASE, "vet-credentials": FAILED_MANDATORY_PHASE, "negotiate-fixed-price": FAILED_MANDATORY_PHASE,
    "commit-agreement": "agreement contradicts failed commitment", rate: undefined,
  };
  try {
    for (const [kind, reason] of Object.entries(expected)) {
      store.clear(); for (const [key, raw] of original) store.set(key, raw);
      const base = structuredClone(listingScope.pipeline) as Obj[];
      const pipeline = base.some((phase) => phase.kind === kind) ? base : kind === "vet-credentials" ? [{ kind }, ...base] : [...base, { kind }];
      store.set(at(30), failedEvidence(kind));
      const graph = await failedPhaseSession(pipeline, { [pipeline.findIndex((phase) => phase.kind === kind)]: "fail" });
      assert.equal(graph.signaturesVerified, true, kind);
      assert.equal(graph.reason, reason, kind);
      const seller = await indexSeller([binding("buyer", at(20), BUYER), binding("seller", at(21), SELLER)]);
      const allowed = kind === "rate";
      assert.equal(graph.refsVerified, allowed, `${kind}: ${graph.reason}`);
      assert.equal(seller.deals[0].refsVerified, allowed, kind);
      assert.equal(seller.deals[0].reputationEligible, allowed, kind);
      assert.equal(seller.reputation.completed, allowed ? 1 : 0, kind);
      assert.equal(seller.reputation.bundleCount, allowed ? 1 : 0, kind);
      assert.deepEqual(seller.reputation.observedTransactionalVolume, allowed ? [{ currency: "DEM", amount: "2" }] : [], kind);
    }
  } finally { store.clear(); for (const [key, raw] of original) store.set(key, raw); }
});

test("ST-2: a completed session with a verified payment and a failed storage delivery counts no completion or volume", async () => {
  const original = new Map(store);
  try {
    // Every listed phase is present and signed for; the delivery phase failed and cites its signed failure evidence.
    store.set(at(30), failedEvidence("deliver-storage-program"));
    const failedDelivery = await failedPhaseSession(structuredClone(listingScope.pipeline) as Obj[], { 3: "fail" });
    assert.deepEqual([failedDelivery.ok, failedDelivery.refsVerified, failedDelivery.reason], [false, false, FAILED_MANDATORY_PHASE]);
    const seller = await indexSeller([binding("buyer", at(20), BUYER), binding("seller", at(21), SELLER)]);
    assert.deepEqual([seller.deals[0].refsVerified, seller.reputation.completed, seller.reputation.observedTransactionalVolume], [false, 0, []]);
    // Two delivery invocations both report ok, but one of their two records is a failure, so the
    // evidence (not the phase entries) carries the failure.
    const repeated = [...structuredClone(listingScope.pipeline) as Obj[], { kind: "deliver-storage-program" }];
    const failedRecord = await failedPhaseSession(repeated, {}, { 4: refTo(at(30), store.get(at(30))!, "evidence") });
    assert.deepEqual([failedRecord.ok, failedRecord.refsVerified, failedRecord.reason], [false, false, FAILED_MANDATORY_PHASE]);
    const repeatedSeller = await indexSeller([binding("buyer", at(20), BUYER), binding("seller", at(21), SELLER)]);
    assert.deepEqual([repeatedSeller.deals[0].refsVerified, repeatedSeller.reputation.completed, repeatedSeller.reputation.observedTransactionalVolume], [false, 0, []]);
    // Control: the same repeated pipeline with two successful records verifies and counts.
    const secondPayload = { report: "second fixture delivery" };
    const secondScope: Obj = { ...deliveryScope, observedAt: 102, deliverableContentHash: contentHash(secondPayload), deliverableAnchor: { kind: "storage-program", locator: at(63) } };
    store.set(at(62), { ...secondScope, signature: signedWith(secondScope, "evidence", SELLER) }).set(at(63), secondPayload);
    const control = await failedPhaseSession(repeated, {}, { 4: refTo(at(62), store.get(at(62))!, "evidence") });
    assert.deepEqual([control.refsVerified, control.reason], [true, undefined]);
  } finally { store.clear(); for (const [key, raw] of original) store.set(key, raw); }
});

test("each signed payment phase requires its own transaction kind and complete ChainTxRef fields", async (t) => {
  const hash = "ab".repeat(32);
  const rails: Array<{ phase: string; ref: Obj; finality: Obj; required: string[] }> = [
    { phase: "pay-dem", ref: { kind: "demos", blockNumber: 1, txHash: hash }, finality: { model: "bft-final" }, required: ["txHash", "blockNumber"] },
    { phase: "pay-evm-erc20", ref: { kind: "evm", chainId: 8453, txHash: hash, logIndex: 0 }, finality: { model: "block-depth", finalityBlocks: 1 }, required: ["chainId", "txHash"] },
    { phase: "pay-solana-spl", ref: { kind: "solana", cluster: "devnet", signature: "1".repeat(64), instructionIndex: 0 }, finality: { model: "commitment-level", finalityCommitmentLevel: "finalized" }, required: ["cluster", "signature", "instructionIndex"] },
    { phase: "pay-x402", ref: { kind: "x402", httpResource: "https://example.com/resource", paymentReceiptHash: hash, protocolVersion: "2", settlementTxHash: hash, chainId: 8453, logIndex: 0 }, finality: { model: "block-depth", finalityBlocks: 1 }, required: ["httpResource", "paymentReceiptHash", "protocolVersion", "chainId"] },
    { phase: "pay-ap2", ref: { kind: "ap2", mandateId: "mandate", providerRef: "receipt", protocolVersion: "1", receiptAttestation: { anchor: { kind: "storage-program", locator: at(60) }, contentHash: contentHash({ receipt: true }) } }, finality: { model: "provider-receipt" }, required: ["mandateId", "providerRef", "protocolVersion", "receiptAttestation"] },
    { phase: "pay-cross-chain-htlc", ref: { kind: "htlc-claim", chainId: 8453, contractAddress: `0x${"12".repeat(20)}`, claimTxHash: hash }, finality: { model: "htlc-reveal" }, required: ["chainId", "contractAddress", "claimTxHash"] },
    { phase: "pay-cross-chain-liquidity-tank", ref: { kind: "liquidity-tank", bridgeId: "bridge", sourceChainId: 1, destChainId: 2, lockTxHash: hash, releaseTxHash: hash }, finality: { model: "liquidity-tank" }, required: ["bridgeId", "sourceChainId", "destChainId", "lockTxHash", "releaseTxHash"] },
  ];
  const receiptCases: Record<string, Obj> = {
    "captured provider receipt without authenticated authority": { status: "captured", amount: "2", currency: "DEM", metadata: { jobId: JOB } },
    "declined provider receipt": { status: "declined", amount: "2", currency: "DEM", metadata: { jobId: JOB } },
    "provider receipt amount mismatch": { status: "captured", amount: "1", currency: "DEM", metadata: { jobId: JOB } },
    "provider receipt currency mismatch": { status: "captured", amount: "2", currency: "USD", metadata: { jobId: JOB } },
    "provider receipt job mismatch": { status: "captured", amount: "2", currency: "DEM", metadata: { jobId: "other-job" } },
  };
  const original = new Map(store);
  try {
    for (const rail of rails) {
      const refsFor = (ref: Obj): Obj[] => rail.phase === "pay-cross-chain-htlc"
        ? [{ kind: "htlc-lock", chainId: 1, contractAddress: "lock", lockTxHash: hash },
           { kind: "htlc-reveal", chainId: 1, contractAddress: "lock", revealTxHash: hash }, ref] : [ref];
      const variants: Array<[string, Obj[], boolean]> = [
        ["valid", refsFor(rail.ref), true],
        ["another rail", [rail.phase === "pay-dem" ? rails[1].ref : rails[0].ref], false],
        ["mixed rails", [rail.ref, rail.phase === "pay-dem" ? rails[1].ref : rails[0].ref], false],
        ["non-object", [null as unknown as Obj], false],
        ...rail.required.map((field): [string, Obj[], boolean] => {
          const ref = { ...rail.ref }; delete ref[field]; return [`missing ${field}`, refsFor(ref), false];
        }),
      ];
      // Keep every other field valid: these cases independently pin kind/type guards.
      variants.push(["wrong kind with complete fields", refsFor({ ...rail.ref, kind: "foreign" }), false]);
      for (const field of ["chainId", "sourceChainId", "destChainId"].filter((key) => key in rail.ref)) {
        for (const value of [-1, "1", null, [1]])
          variants.push([`${field} ${JSON.stringify(value)}`, refsFor({ ...rail.ref, [field]: value }), false]);
        variants.push([`${field} zero`, refsFor({ ...rail.ref, [field]: 0 }), true]);
      }
      for (const field of rail.required.filter((key) => /Hash$/.test(key))) {
        for (const value of [null, [hash], "a".repeat(63), "a".repeat(65), `junk${hash}`, `${hash}junk`])
          variants.push([`${field} ${JSON.stringify(value)}`, refsFor({ ...rail.ref, [field]: value }), false]);
      }
      for (const field of ["httpResource", "mandateId", "providerRef", "protocolVersion", "contractAddress", "bridgeId"].filter((key) => key in rail.ref)) {
        for (const value of ["", " ", null])
          variants.push([`blank ${field} ${JSON.stringify(value)}`, refsFor({ ...rail.ref, [field]: value }), false]);
      }
      if (rail.phase === "pay-cross-chain-htlc") {
        const full = refsFor(rail.ref);
        for (let index = 0; index < full.length; index++)
          variants.push([`missing HTLC stage ${index}`, full.filter((_, i) => i !== index), false]);
        const refund = { kind: "htlc-refund", chainId: 1, contractAddress: "lock", refundTxHash: hash };
        variants.push(["refund alone", [refund], false], ["refund beside successful stages", [...full, refund], false]);
      }
      if (rail.phase === "pay-ap2") for (const [name, body] of Object.entries(receiptCases)) {
        variants.push([name, [{ ...rail.ref, receiptAttestation: { anchor: { kind: "storage-program", locator: at(62) }, contentHash: contentHash(body) } }], true]);
      }
      if (rail.phase === "pay-x402") {
        const receiptOnly = { ...rail.ref }; delete receiptOnly.settlementTxHash; delete receiptOnly.chainId;
        variants.push(["provider receipt", [receiptOnly], true]);
        variants.push(["receipt hash without a matching preimage", [{ ...rail.ref, paymentReceiptHash: "cd".repeat(32) }], true]);
        variants.push(["receipt network mismatch without authenticated response", [{ ...rail.ref, chainId: 1 }], true]);
        variants.push(["receipt transaction mismatch without authenticated response", [{ ...rail.ref, settlementTxHash: "cd".repeat(32) }], true]);
        variants.push(["uppercase receipt hash", [{ ...rail.ref, paymentReceiptHash: hash.toUpperCase() }], false]);
        variants.push(["prefixed receipt hash", [{ ...rail.ref, paymentReceiptHash: `0x${hash}` }], false]);
        for (const version of ["0", "3", "12", "999", "02", ["2"], 2])
          variants.push([`unsupported protocol ${JSON.stringify(version)}`, [{ ...rail.ref, protocolVersion: version }], false]);
        variants.push(["version 1", [{ ...rail.ref, protocolVersion: "1" }], true]);
        variants.push(["orphan chainId", [Object.fromEntries(Object.entries(rail.ref).filter(([key]) => key !== "settlementTxHash"))], false]);
      }
      if (["pay-evm-erc20", "pay-solana-spl"].includes(rail.phase)) {
        variants.push(["asserted settlement with wrong amount", [{ ...rail.ref, amount: "1", status: "confirmed" }], true]);
        variants.push(["asserted settlement with wrong payee", [{ ...rail.ref, to: dids[OUTSIDER], status: "confirmed" }], true]);
        variants.push(["nonexistent transaction without proof", [{ ...rail.ref, ...(rail.phase === "pay-evm-erc20" ? { txHash: "cd".repeat(32) } : { signature: "2".repeat(64) }) }], true]);
      }
      if (rail.phase === "pay-evm-erc20") {
        const ref = { ...rail.ref }; delete ref.logIndex;
        variants.push(["upstream ref without logIndex", [ref], true]);
      }
      for (const [name, refs, expected] of variants) {
        await t.test(`${rail.phase}: ${name}`, async () => {
        store.clear(); for (const [key, raw] of original) store.set(key, raw);
        store.set(at(62), receiptCases[name] ?? { receipt: true });
        const railId = rail.phase === "pay-dem" ? "demos-native:DEM" : rail.phase;
        const listedScope = { ...listingScope, pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: rail.phase, parameters: { rail: railId } }, { kind: "deliver-storage-program" }], acceptedRails: [{ railId }] };
        const listed = { ...listedScope, signature: signedWith(listedScope, "listing", SELLER) };
        store.set(at(1), listed);
        const listingRef = { listingId: "binding-rules", version: 1, contentHash: artifactHash(listed, "listing") };
        const agreedScope = { ...agreementScope, listingRef, terms: { ...agreementScope.terms as Obj, rail: { railId } } };
        const agreed = { ...agreedScope, signatures: [signedWith(agreedScope, "agreement", BUYER, "party"), signedWith(agreedScope, "agreement", SELLER, "party")] };
        store.set(at(2), agreed);
        const paidScope = { ...evidenceScope, phase: rail.phase, paymentTxRefs: refs, settlementFinality: { ...rail.finality, ...(name === "provider receipt" || name === "orphan chainId" ? { model: "provider-receipt" } : {}), finalityObservedAt: 100 } };
        const paid = { ...paidScope, signature: signedWith(paidScope, "evidence", SELLER) };
        store.set(at(3), paid);
        const scope = bundleScope({ listingRef, agreementRef: refTo(at(2), agreed, "agreement"), phaseSummary: [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" }, { index: 2, kind: rail.phase, outcome: "ok" }, { index: 3, kind: "deliver-storage-program", outcome: "ok" }], settlementEvidence: [refTo(at(3), paid, "evidence"), refTo(at(60), delivery, "evidence")] });
        store.set(at(20), copy("buyer", scope)).set(at(21), copy("seller", scope));
        const graph = await buildCurrentEvidenceGraph(at(20), {
          readSettlementNode: nativeNodeFixture(() => store.values()),
        read: async (locator) => store.get(locator) ?? null,
          readAnchorRecord: async (locator) => ({ data: store.get(locator)!, acl: { mode: "public" }, programName: OPAQUE_PROGRAM_NAME }),
          resolveListing: async () => ({ locator: at(1), raw: listed }),
        });
        assert.equal(graph.signaturesVerified, true, `${rail.phase}: ${name}`);
        const verified = expected && rail.phase === "pay-dem";
        assert.equal(graph.refsVerified, verified, `${rail.phase}: ${name}: ${graph.reason}`);
        const seller = await indexSeller([binding("buyer", at(20), BUYER), binding("seller", at(21), SELLER)], [], railId);
        // AP2, HTLC, tank and receipt-only x402 intentionally have no supported SB-1 key.
        const counted = verified && name !== "upstream ref without logIndex" && ["pay-dem", "pay-evm-erc20", "pay-solana-spl", "pay-x402"].includes(rail.phase) && name !== "provider receipt";
        assert.equal(seller.deals[0].refsVerified, verified, `${rail.phase}: ${name}: catalog reference status`);
        assert.equal(seller.deals[0].reputationEligible, counted, `${rail.phase}: ${name}`);
        assert.equal(seller.reputation.completed, counted ? 1 : 0, `${rail.phase}: ${name}`);
        assert.deepEqual(seller.reputation.observedTransactionalVolume, counted ? [{ currency: "DEM", amount: "2" }] : [], `${rail.phase}: ${name}`);
        });
      }
    }
  } finally { store.clear(); for (const [key, raw] of original) store.set(key, raw); }
});

test("required vet execution binds presented claims, verification and phase pointers before catalog admission", async (t) => {
  const original = new Map(store);
  const originalSnapshots = process.env.DACS_RECIPE_SNAPSHOTS;
  const originalPolicies = process.env.DACS_RECIPE_POLICIES;
  type VetCase = { snapshotControl?: boolean; registryVersion?: number; snapshotPolicies?: Obj[]; firstAttempt?: "buyer" | "seller"; challengeTiming?: Obj; challenge?: "missing" | "foreign-job" | "reused" | "other-presentation" | "scope-only" | "legacy-marker" | "missing-digest"; name: string; expected?: boolean; buyer?: Obj; result?: Obj; claim?: Obj; requirement?: Obj;
    noClaim?: boolean; noIdentity?: boolean; badHash?: boolean; badPresentation?: boolean; noVet?: boolean;
    records?: "none" | "buyer" | "seller" | "wrong-requirement" | "failed" | "empty" | "supplementary";
    omittedVet?: boolean; pointer?: "composite" | "result" | "failed-result" | "foreign" | "evidence";
    policy?: Obj[]; wrongLocator?: boolean; hashPrefix?: string; rawPolicy?: string; callback?: boolean; primaryProof?: boolean; control?: "missing" | "rejects"; badAuthority?: boolean; malformedFreshness?: boolean; identityRef?: boolean; generatedAt?: number; verifiedByVersion?: number; sellerFromListing?: boolean; badAnchorHash?: boolean; bundleOutcome?: string; graphOnly?: boolean };
  const requirement = { requirementVersion: "1", required: [{ scheme: "lei", verificationRequired: true, recipeVersion: 1 }] };
  const livePolicy = { scheme: "lei", recipeVersion: 1, defaultMaxAgeSec: 1, methods: ["verifiable-credential"], availability: "live", trustedResultSigners: [dids[OUTSIDER]] };
  // DACS-2 §7.12: the presented primary needs its own verified claim under a roster recipe,
  // plus a trusted control adapter. Cases opt out with primaryProof: false.
  const primaryPolicy = { ...livePolicy, scheme: "did" };
  const cases: VetCase[] = [
    { name: "unknown positive recipe registry pin", snapshotControl: true, registryVersion: 999, graphOnly: true },
    { name: "result missing from recipe snapshot", snapshotControl: true, snapshotPolicies: [{ recipeVersion: 2 }], graphOnly: true },
    { name: "unversioned requirement selects session-start latest", snapshotControl: true, requirement: { requirementVersion: "1", required: [{ scheme: "lei", verificationRequired: true }] }, snapshotPolicies: [{}, { recipeVersion: 2 }], graphOnly: true },
    { name: "explicit older recipe remains selectable in snapshot", snapshotPolicies: [{}, { recipeVersion: 2 }], expected: true, graphOnly: true },
    { name: "snapshot default freshness cannot use a different policy list", snapshotControl: true, result: { validUntil: undefined }, snapshotPolicies: [{ defaultMaxAgeSec: 0 }], graphOnly: true },
    { name: "both parties passed with valid first presentation attempts", expected: true },
    { name: "invalid buyer first attempt consumes nonce before a valid retry", firstAttempt: "buyer" },
    { name: "invalid seller first attempt consumes nonce before a valid retry", firstAttempt: "seller" },
    { name: "anchored valid retry cannot replace invalid first attempt", firstAttempt: "buyer", identityRef: true },
    { name: "callback valid retry cannot replace invalid first attempt", firstAttempt: "buyer", callback: true, graphOnly: true },
    { name: "signed scope hash cannot identify the first attempt", challenge: "scope-only" },
    { name: "legacy bundle hash marker cannot authorize an attempt", challenge: "legacy-marker" },
    { name: "missing complete attempt digest", challenge: "missing-digest" },
    { name: "missing authenticated historical challenge", challenge: "missing" },
    { name: "missing session nonce", buyer: { sessionNonce: undefined } },
    { name: "mismatched session nonce", buyer: { sessionNonce: "different-challenge" } },
    { name: "challenge belongs to another job", challenge: "foreign-job" },
    { name: "challenge consumed by another job", challenge: "reused" },
    { name: "same-job challenge consumed by a different presentation", challenge: "other-presentation" },
    { name: "diagnostic timestamp before challenge issuance", buyer: { presentedAt: -100 }, expected: true },
    { name: "diagnostic timestamp after expiry and finalisation", buyer: { presentedAt: 121 }, expected: true },
    { name: "first consuming attempt before issuance", challengeTiming: { consumedAt: -1 } },
    { name: "first consuming attempt after expiry", challengeTiming: { consumedAt: 121 } },
    { name: "first consuming attempt after expiry but before finalisation", challengeTiming: { expiresAt: 100, consumedAt: 110 } },
    { name: "first consuming attempt after finalisation", challengeTiming: { expiresAt: 200, consumedAt: 121 } },
    { name: "missing authenticated consumption time", challengeTiming: { consumedAt: undefined } },
    { name: "nonfinite authenticated consumption time", challengeTiming: { consumedAt: Number.NaN } },
    { name: "first consuming attempt exactly at issuance", challengeTiming: { consumedAt: 0 }, expected: true },
    { name: "first consuming attempt exactly at expiry", challengeTiming: { consumedAt: 120 }, expected: true },
    ...["mocked", "disabled", "failed"].map((availability) => ({ name: `unusable recipe ${availability}`, policy: [{ availability }] })),
    { name: "recipe forbids result method", policy: [{ methods: ["other"] }] },
    { name: "recipe has no trusted signer", policy: [{ trustedResultSigners: [] }] },
    { name: "recipe trusts another signer", policy: [{ trustedResultSigners: [dids[SELLER]] }] },
    { name: "missing recipe even with explicit expiry", policy: [] },
    { name: "other recipe version even with explicit expiry", policy: [{ recipeVersion: 2 }] },
    { name: "unknown recipe availability", policy: [{ availability: "unknown" }] },
    { name: "trusted gated recipe", policy: [{ availability: "operator_gated" }] },
    { name: "trusted closed-data recipe", policy: [{ availability: "closed_data" }] },
    { name: "trusted bilateral recipe", policy: [{ availability: "bilateral" }] },
    { name: "optional gated vet result also needs disclosure", policy: [{ availability: "operator_gated" }], requirement: { requirementVersion: "1", required: [] } },
    { name: "optional live vet result", requirement: { requirementVersion: "1", required: [] }, expected: true },
    ...["mocked", "disabled", "failed"].map((availability) => ({ name: `optional unusable recipe ${availability}`, policy: [{ availability }], requirement: { requirementVersion: "1", required: [] } })),
    { name: "optional missing recipe policy", policy: [], requirement: { requirementVersion: "1", required: [] } },
    { name: "optional gated untrusted signer", policy: [{ availability: "operator_gated", trustedResultSigners: [] }], requirement: { requirementVersion: "1", required: [] } },
    { name: "optional gated forbidden method", policy: [{ availability: "operator_gated", methods: ["other"] }], requirement: { requirementVersion: "1", required: [] } },
    { name: "malformed recipe JSON", rawPolicy: "{invalid", result: { validUntil: undefined } },
    { name: "other scheme policy", policy: [{ scheme: "domain" }], result: { validUntil: undefined } },
    { name: "nonnumeric recipe lifetime", policy: [{ defaultMaxAgeSec: "1" }], result: { validUntil: undefined } },
    { name: "authority evidence hash mismatch", badAuthority: true },
    { name: "callback resolves presented identity", callback: true, graphOnly: true, expected: true },
    { name: "callback identity wrong hash", callback: true, badHash: true, graphOnly: true },
    { name: "callback identity invalid presentation", callback: true, badPresentation: true, graphOnly: true },
    { name: "verified selected primary with independent required claim", requirement: { ...requirement, primaryClaimSelector: "did" }, expected: true },
    { name: "missing primary control adapter fails closed", control: "missing", graphOnly: true },
    { name: "rejecting primary control adapter fails closed", control: "rejects", graphOnly: true },
    { name: "only oneOf still requires vet pipeline", noVet: true, requirement: { requirementVersion: "1", required: [], oneOf: [[{ scheme: "lei", verificationRequired: true }]] } },
    { name: "only oneOf still requires vet execution", omittedVet: true, requirement: { requirementVersion: "1", required: [], oneOf: [[{ scheme: "lei", verificationRequired: true }]] } },
    { name: "only selector still requires vet pipeline", noVet: true, requirement: { requirementVersion: "1", required: [], primaryClaimSelector: "did" } },
    { name: "only selector still requires vet execution", omittedVet: true, requirement: { requirementVersion: "1", required: [], primaryClaimSelector: "did" } },
    { name: "only oneOf successful proof", requirement: { requirementVersion: "1", required: [], oneOf: [[{ scheme: "lei", verificationRequired: true }]] }, expected: true },
    { name: "only selector successful proof", requirement: { requirementVersion: "1", required: [], primaryClaimSelector: "did" }, expected: true },
    { name: "empty oneOf permits no vet pipeline", noVet: true, requirement: { requirementVersion: "1", required: [], oneOf: [] }, expected: true },
    { name: "nonrequired composite malformed freshness", malformedFreshness: true, requirement: { requirementVersion: "1", required: [] } },
    { name: "passing composite pointer", pointer: "composite", expected: true },
    { name: "passing VerifyResult pointer", pointer: "result", expected: true },
    { name: "failed VerifyResult pointer beside valid proof", pointer: "failed-result" },
    { name: "pointer outside graph", pointer: "foreign" },
    { name: "vet pointer to payment evidence", pointer: "evidence" },
    { name: "omitted vet execution", omittedVet: true },
    { name: "requirements without vet in pipeline", noVet: true },
    { name: "failed committed session still requires a vet pipeline", noVet: true, bundleOutcome: "failed-perm", graphOnly: true },
    { name: "failed committed session still requires vet execution", omittedVet: true, bundleOutcome: "failed-perm", graphOnly: true },
    { name: "failed committed session retains valid vet evidence", bundleOutcome: "failed-perm", graphOnly: true, expected: true },
    { name: "ok summary without records", records: "none" },
    { name: "buyer record alone", records: "buyer" },
    { name: "seller record alone", records: "seller" },
    { name: "wrong requirement", records: "wrong-requirement" },
    { name: "failed buyer vet", records: "failed" },
    { name: "empty required verification", records: "empty" },
    { name: "supplementary cannot satisfy required verification", records: "supplementary" },
    { name: "missing IdentityBundle", noIdentity: true },
    { name: "missing presentation timestamp", buyer: { presentedAt: undefined } },
    { name: "presentation timestamp must be numeric", buyer: { presentedAt: "1" } },
    { name: "presentation timestamp cannot be null", buyer: { presentedAt: null } },
    { name: "wrong IdentityBundle hash", badHash: true },
    { name: "invalid IdentityBundle presentation", badPresentation: true },
    { name: "IdentityBundle belongs to another party", buyer: { presentedBy: dids[OUTSIDER] } },
    { name: "required scheme absent from IdentityBundle", noClaim: true },
    { name: "claim trailing newline cannot alias required identity", claim: { ref: "lei:5493001KJTIIGC8Y1R12\n" } },
    { name: "result identifies another claim", claim: { ref: "lei:11111111111111111111" } },
    { name: "missing verifiedBy", claim: { verifiedBy: undefined } },
    { name: "verifiedBy points to another locator", claim: { verifiedBy: { anchor: { kind: "storage-program", locator: at(82) }, contentHash: "0".repeat(64), recipeVersion: 1 } } },
    { name: "verifiedBy locator cannot borrow another result hash", wrongLocator: true },
    { name: "prefixed uppercase verifiedBy hash", hashPrefix: "sha256:", expected: true },
    { name: "result scheme must match required presented claim", result: { scheme: "did" }, policy: [{ scheme: "did" }] },
    { name: "verifiedBy has wrong content hash", claim: { verifiedBy: { anchor: { kind: "storage-program", locator: at(81) }, contentHash: "0".repeat(64), recipeVersion: 1 } } },
    { name: "verifiedBy has wrong recipe version", verifiedByVersion: 2 },
    { name: "result fails", result: { decision: "fail" } },
    { name: "result stale at vet time", result: { validUntil: 29 } },
    { name: "wrapper cannot extend authority expiry", result: { validUntil: 29 }, claim: { issuedAt: 30, expiresAt: 1000 } },
    { name: "wrapper narrows authority expiry", claim: { expiresAt: 29 } },
    { name: "authority expiry must be numeric", result: { validUntil: "100" } },
    { name: "wrapper expiry must be numeric", claim: { expiresAt: "100" } },
    { name: "zero-length authority and listing windows", generatedAt: 20, result: { validUntil: 20 }, requirement: { ...requirement, required: [{ scheme: "lei", verificationRequired: true, maxAge: 0 }] }, expected: true },
    { name: "zero-length fallback window", generatedAt: 20, result: { validUntil: undefined }, policy: [{ defaultMaxAgeSec: 0 }], expected: true },
    { name: "freshness boundary is inclusive", result: { validUntil: 30 }, expected: true },
    { name: "future verification", result: { verifiedAt: 31 } },
    { name: "invalid authority window", result: { validUntil: 19 } },
    { name: "missing authority window and pinned recipe", result: { validUntil: undefined }, policy: [] },
    { name: "pinned recipe fallback", result: { validUntil: undefined }, policy: [{ scheme: "lei", recipeVersion: 1, defaultMaxAgeSec: 1 }], expected: true },
    { name: "another recipe version cannot supply freshness", result: { validUntil: undefined }, policy: [{ scheme: "lei", recipeVersion: 2, defaultMaxAgeSec: 1 }] },
    { name: "stale recipe fallback", result: { validUntil: undefined }, policy: [{ scheme: "lei", recipeVersion: 1, defaultMaxAgeSec: 0 }] },
    { name: "listing maxAge tightens authority window", requirement: { ...requirement, required: [{ scheme: "lei", verificationRequired: true, maxAge: 1 }] }, generatedAt: 2020, result: { validUntil: 10000 } },
    { name: "listing maxAge inclusive boundary", requirement: { ...requirement, required: [{ scheme: "lei", verificationRequired: true, maxAge: 2 }] }, generatedAt: 2020, result: { validUntil: 10000 }, expected: true },
    { name: "listing recipe version must match", requirement: { ...requirement, required: [{ scheme: "lei", verificationRequired: true, recipeVersion: 2 }] } },
    { name: "unrecognised parameters cannot silently pass", requirement: { ...requirement, required: [{ scheme: "lei", verificationRequired: true, parameters: { jurisdiction: "US" } }] } },
    { name: "selector must match presentedBy", requirement: { ...requirement, primaryClaimSelector: "lei" } },
    { name: "unsatisfied oneOf", requirement: { ...requirement, oneOf: [[{ scheme: "domain", verificationRequired: true }]] } },
    { name: "oneOf passing alternative", requirement: { ...requirement, oneOf: [[{ scheme: "domain", verificationRequired: true }, { scheme: "lei", verificationRequired: true }]] }, expected: true },
    { name: "every oneOf group must pass", requirement: { ...requirement, oneOf: [[{ scheme: "lei", verificationRequired: true }], [{ scheme: "domain", verificationRequired: true }]] } },
    { name: "requirement scheme matches case-insensitively", requirement: { ...requirement, required: [{ scheme: "LEI", verificationRequired: true }] }, expected: true },
    { name: "canonical identity ignores reference parameters", claim: { ref: "LEI:5493001kjtiigc8y1r12?jurisdiction=US" }, expected: true },
    { name: "hash-bound anchored IdentityBundle", identityRef: true, expected: true },
    { name: "anchored IdentityBundle reference has wrong hash", identityRef: true, badAnchorHash: true },
    { name: "publisher listing identity cannot replace session identity", sellerFromListing: true },
    { name: "selector requires the exact presentedBy verification", primaryProof: false, requirement: { ...requirement, primaryClaimSelector: "did" } },
    { name: "oneOf alternative must occur in presented claims", noClaim: true, requirement: { requirementVersion: "1", required: [], oneOf: [[{ scheme: "lei", verificationRequired: true }]] } },
    { name: "freshness is mandatory even without verificationRequired", result: { validUntil: 29 }, requirement: { ...requirement, required: [{ scheme: "lei", verificationRequired: false }] } },
    { name: "issuedAt cannot widen listing maxAge", claim: { issuedAt: 2020 }, requirement: { ...requirement, required: [{ scheme: "lei", verificationRequired: true, maxAge: 1 }] }, generatedAt: 2020, result: { validUntil: 10000 } },
  ];
  const presented = (party: number, scope: Obj) => ({ ...scope, presentation: { kind: "per-claim", signatures: [{ ref: dids[party],
    signature: Buffer.from(ed25519Sign(Buffer.from(`dacs-bundle-presentation:v1:${contentHash(scope)}`), privateKeyFromSeed(seeds[party]))).toString("hex") }] } });
  try {
    for (const c of cases) await t.test(c.name, async () => {
      store.clear(); for (const [key, raw] of original) store.set(key, raw);
      const primaryProof = c.primaryProof ?? true;
      const roster = (policies: Obj[]) => primaryProof && !policies.some((policy) => policy.scheme === "did" && policy.recipeVersion === 1)
        ? [...policies, primaryPolicy] : policies;
      process.env.DACS_RECIPE_POLICIES = c.rawPolicy ?? JSON.stringify(roster((c.policy ?? [{}]).map((policy) => ({ ...livePolicy, ...policy }))));
      try { process.env.DACS_RECIPE_SNAPSHOTS = JSON.stringify([{ registryVersion: 1, recipes: c.snapshotPolicies ? roster(c.snapshotPolicies.map((policy) => ({ ...livePolicy, ...policy }))) : JSON.parse(process.env.DACS_RECIPE_POLICIES!) }]); } catch { process.env.DACS_RECIPE_SNAPSHOTS = "[]"; }
      const req = c.requirement ?? requirement;
      const pipeline = [...(c.noVet ? [] : [{ kind: "vet-credentials" }]), { kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }, { kind: "deliver-storage-program" }];
      const listedScope = { ...listingScope, buyerRequirement: req, pipeline };
      const listed = { ...listedScope, signature: signedWith(listedScope, "listing", SELLER) };
      const pinned = { ...listingRef, contentHash: artifactHash(listed, "listing") };
      const agreedScope = { ...agreementScope, listingRef: pinned };
      const agreed = { ...agreedScope, signatures: [signedWith(agreedScope, "agreement", BUYER, "party"), signedWith(agreedScope, "agreement", SELLER, "party")] };
      const attestation = authorityProof({ authority: "registry", decision: "pass" }, 7, c.snapshotControl ? "proofSignature" : "signature");
      const resultBase: Obj = { resultVersion: "1", scheme: "lei", identifier: "5493001KJTIIGC8Y1R12", recipeVersion: 1,
        method: "verifiable-credential", decision: "pass", reason: "registry match", fetchedAt: 10, verifiedAt: 20, validUntil: 100,
        attestation: { anchor: { kind: "storage-program", locator: at(80) }, contentHash: proofHash(attestation), signer: authoritySigner } };
      const resultScope: Obj = { ...resultBase, ...c.result };
      for (const key of Object.keys(resultScope)) if (resultScope[key] === undefined) delete resultScope[key];
      const result = { ...resultScope, signature: signedWith(resultScope, "verify-result", OUTSIDER) };
      const resultRef = { ...refTo(at(81), result, "verify-result"), recipeVersion: 1 };
      const claim: Obj = { ref: "lei:5493001KJTIIGC8Y1R12", verifiedBy: { ...resultRef, recipeVersion: c.verifiedByVersion ?? 1 }, ...c.claim };
      for (const key of Object.keys(claim)) if (claim[key] === undefined) delete claim[key];
      if (c.wrongLocator) (claim.verifiedBy as Obj).anchor = { kind: "storage-program", locator: at(82) };
      if (c.hashPrefix) (claim.verifiedBy as Obj).contentHash = c.hashPrefix + String(resultRef.contentHash).toUpperCase();
      // The primary's own passing result ignores c.result, so result overrides still target the required claim alone.
      const primaryScope: Obj = { ...resultBase, scheme: "did", identifier: dids[BUYER].slice(4), validUntil: 10000 };
      const primaryResult = { ...primaryScope, signature: signedWith(primaryScope, "verify-result", OUTSIDER) };
      const primaryRef = { ...refTo(at(85), primaryResult, "verify-result"), recipeVersion: 1 };
      store.set(at(85), primaryResult);
      const buyerScope: Obj = { bundleVersion: "1", presentedBy: dids[BUYER], presentedAt: 1, sessionNonce: `challenge-${dids[BUYER]}`,
        claims: [{ ref: dids[BUYER], ...(primaryProof ? { verifiedBy: primaryRef } : {}) }, ...(c.noClaim ? [] : [claim])], ...c.buyer };
      for (const key of Object.keys(buyerScope)) if (buyerScope[key] === undefined) delete buyerScope[key];
      const sellerScope = { ...identity, sessionNonce: `challenge-${dids[SELLER]}` };
      const buyerIdentity = presented(BUYER, buyerScope);
      if (c.badPresentation) buyerIdentity.presentation.signatures[0].signature = "00".repeat(64);
      const sellerIdentity = presented(SELLER, sellerScope);
      const firstAttempts = new Map([[dids[BUYER], buyerIdentity], [dids[SELLER], sellerIdentity]]);
      if (c.firstAttempt) {
        const partyIndex = c.firstAttempt === "buyer" ? BUYER : SELLER;
        const valid = partyIndex === BUYER ? buyerIdentity : sellerIdentity;
        const invalid = structuredClone(valid);
        invalid.presentation.signatures[0].signature = "00".repeat(64);
        const scopeOf = (value: Obj) => { const scope = { ...value }; delete scope.presentation; return scope; };
        // The first failed attempt and valid retry share every signed field, nonce and timestamp.
        assert.equal(contentHash(scopeOf(invalid)), contentHash(scopeOf(valid)));
        assert.notEqual(sha256Hex(canonicalize(invalid)), sha256Hex(canonicalize(valid)));
        assert.equal(await verifyIdentityPresentation(invalid, dids[partyIndex], resolveDemosPrimaryClaimKey), null);
        assert.ok(await verifyIdentityPresentation(valid, dids[partyIndex], resolveDemosPrimaryClaimKey));
        firstAttempts.set(dids[partyIndex], invalid);
      }
      const parties: Obj[] = [BUYER, SELLER].map((party) => ({ role: party === BUYER ? "buyer" : "seller", primaryClaim: dids[party],
        bundleHash: contentHash(party === BUYER ? buyerScope : sellerScope), identityBundle: party === BUYER ? buyerIdentity : sellerIdentity }));
      if (c.noIdentity || c.callback) delete parties[BUYER].identityBundle;
      if (c.sellerFromListing) delete parties[SELLER].identityBundle;
      if (c.badHash) parties[BUYER].bundleHash = "a".repeat(64);
      if (c.identityRef) { delete parties[BUYER].identityBundle; parties[BUYER].identityBundleRef = { anchor: { kind: "storage-program", locator: at(83) }, contentHash: c.badAnchorHash ? "0".repeat(64) : parties[BUYER].bundleHash }; store.set(at(83), buyerIdentity); }
      const composite = (party: number): Obj => {
        const scope = { recordVersion: "1", jobId: JOB, evaluatedParty: dids[party], bundleHash: parties[party].bundleHash,
          requirementHash: contentHash(party === BUYER ? req : { requirementVersion: "1", required: [] }),
          freshness: party === BUYER ? [resultRef, ...(primaryProof ? [primaryRef] : [])] : (c.malformedFreshness ? [{ contentHash: "0".repeat(64) }] : []), dealSpecific: [], supplementary: [], overallDecision: "pass", generatedAt: c.generatedAt ?? 30 } as Obj;
        if (party === BUYER) {
          if (c.records === "wrong-requirement") scope.requirementHash = "0".repeat(64);
          if (c.records === "failed") scope.overallDecision = "fail";
          if (c.records === "empty" || c.records === "supplementary") scope.freshness = [];
          if (c.records === "supplementary") scope.supplementary = [{ kind: "credential", attestation: resultScope.attestation }];
        }
        return { ...scope, signature: signedWith(scope, "composite", OUTSIDER) };
      };
      const records = c.records === "none" ? [] : c.records === "buyer" ? [composite(BUYER)] : c.records === "seller" ? [composite(SELLER)] : [composite(BUYER), composite(SELLER)];
      store.set(at(1), listed).set(at(2), agreed).set(at(80), c.badAuthority ? { ...attestation, decision: "fail" } : attestation).set(at(81), result);
      if (c.pointer === "failed-result") {
        const failedScope = { ...resultScope, decision: "fail" }; const failed = { ...failedScope, signature: signedWith(failedScope, "verify-result", OUTSIDER) };
        store.set(at(82), failed);
        const scope: Obj = { ...records[0], dealSpecific: [{ ...refTo(at(82), failed, "verify-result"), recipeVersion: 1 }] }; delete scope.signature;
        records[0] = { ...scope, signature: signedWith(scope, "composite", OUTSIDER) };
      }
      const refs = records.map((record, index) => { store.set(at(70 + index), record); return refTo(at(70 + index), record, "composite"); });
      const pointer = c.pointer === "composite" ? refs[0] : c.pointer === "result" ? resultRef :
        c.pointer === "failed-result" ? refTo(at(82), store.get(at(82))!, "verify-result") :
        c.pointer === "foreign" ? { ...resultRef, anchor: { kind: "storage-program", locator: at(84) } } :
        c.pointer === "evidence" ? refTo(at(3), evidence, "evidence") : undefined;
      // DACS-5 §10.3.1: a failed session ends in a failed phase of its class, the delivery here.
      const failedEnd = Boolean(c.bundleOutcome?.startsWith("failed-"));
      const ends = (index: number) => failedEnd && index === pipeline.length - 1;
      const phaseSummary = pipeline.flatMap((phase, index) => c.omittedVet && index === 0 ? [] :
        [{ index, kind: phase.kind, outcome: ends(index) ? "fail" : "ok", ...(ends(index) ? { errorClass: "permanent" } : {}),
          ...(index === 0 && pointer ? { attestationRef: pointer } : {}) }]);
      const failedDeliveryScope = { ...deliveryScope, outcome: "failure" };
      const failedDelivery = { ...failedDeliveryScope, signature: signedWith(failedDeliveryScope, "evidence", SELLER) };
      if (failedEnd) store.set(at(66), failedDelivery);
      const scope = bundleScope({ recipeRegistryVersion: c.registryVersion ?? 1, listingRef: pinned, agreementRef: refTo(at(2), agreed, "agreement"), parties, outcome: c.bundleOutcome ?? "completed", vetRecords: refs, phaseSummary, finalisedAt: Math.max(120, c.generatedAt ?? 30),
        ...(failedEnd ? { settlementEvidence: [refTo(at(3), evidence, "evidence"), refTo(at(66), failedDelivery, "evidence")] } : {}) });
      store.set(at(20), copy("buyer", scope)).set(at(21), copy("seller", scope));
      const buildGraph = () => buildCurrentEvidenceGraph(at(20), {
        verifyAttestation: verifyTestAuthority,
        resolveSessionChallenge: async (jobId, party) => {
          if (c.challenge === "missing" || c.challenge === "reused") return null;
          const challenge = {
            jobId: c.challenge === "foreign-job" ? "foreign-job" : jobId,
            party: String(party.primaryClaim), nonce: `challenge-${party.primaryClaim}`,
            issuedAt: 0, expiresAt: 120, consumedAt: 1,
            consumedByPresentationHash: c.challenge === "other-presentation" ? "0".repeat(64)
              : c.challenge === "scope-only" ? String(party.bundleHash)
              : sha256Hex(canonicalize(firstAttempts.get(String(party.primaryClaim)))), ...c.challengeTiming,
          };
          if (c.challenge === "missing-digest" || c.challenge === "legacy-marker") {
            delete (challenge as Obj).consumedByPresentationHash;
          }
          // Keep the obsolete scope marker as a decoy: it must never override the complete digest.
          return { ...challenge, consumedByBundleHash: c.challenge === "other-presentation"
            ? "0".repeat(64) : String(party.bundleHash) };
        },
        resolveIdentityBundle: c.callback ? async () => buyerIdentity : undefined,
        // Fixture control verifier for the buyer's exact primary and result; production installs none.
        verifyPrimaryClaimControl: c.control === "missing" ? undefined : async ({ identity, primary, result }) =>
          c.control !== "rejects" && identity.presentedBy === dids[BUYER] && `did:${primary.identifier}` === dids[BUYER] && result.locator === at(85),
        readSettlementNode: nativeNodeFixture(() => store.values()),
        read: async (locator) => store.get(locator) ?? null,
        readAnchorRecord: async (locator) => ({ data: store.get(locator)!, acl: { mode: "public" }, programName: OPAQUE_PROGRAM_NAME }),
        resolveListing: async () => ({ locator: at(1), raw: listed }),
      });
      if (c.snapshotControl) {
        const selectedSnapshot = process.env.DACS_RECIPE_SNAPSHOTS;
        process.env.DACS_RECIPE_SNAPSHOTS = JSON.stringify([{ registryVersion: 1, recipes: roster([livePolicy]) }]);
        const controlScope = { ...scope, recipeRegistryVersion: 1 };
        store.set(at(20), copy("buyer", controlScope)).set(at(21), copy("seller", controlScope));
        const control = await buildGraph();
        assert.equal(control.ok, true, `${c.name} positive control: ${control.reason}`);
        process.env.DACS_RECIPE_SNAPSHOTS = selectedSnapshot;
        store.set(at(20), copy("buyer", scope)).set(at(21), copy("seller", scope));
      }
      const graph = await buildGraph();
      if (c.snapshotControl) {
        assert.equal(graph.reason, c.registryVersion === 999 ? "recipe registry snapshot is unavailable"
          : c.name === "result missing from recipe snapshot" ? "vet recipe availability is indeterminate: invalid policy"
          : "committed vet lacks passing verification evidence for the listing's requirements");
      }
      const expected = c.expected ?? false;
      assert.equal(graph.signaturesVerified, true, c.name);
      assert.equal(graph.ok, expected, `${c.name}: ${graph.reason}`);
      assert.equal(graph.refsVerified, expected, c.name);
      if (c.firstAttempt || ["scope-only", "legacy-marker", "missing-digest"].includes(c.challenge ?? "") || (c.challengeTiming && !expected)) {
        assert.match(graph.reason ?? "", /authenticated historical challenge is unavailable or mismatched/);
      }
      if (c.graphOnly) return;
      const seller = await indexSeller([binding("buyer", at(20), BUYER), binding("seller", at(21), SELLER)]);
      // Production has no authority-proof adapter, including for optional included results.
      const indexed = expected && c.noVet && records.every((record) =>
        (record.freshness as unknown[]).length === 0 && (record.dealSpecific as unknown[]).length === 0);
      assert.equal(seller.deals[0].refsVerified, Boolean(indexed), c.name);
      assert.equal(seller.deals[0].reputationEligible, Boolean(indexed), c.name);
      assert.equal(seller.reputation.completed, indexed ? 1 : 0, c.name);
      assert.deepEqual(seller.reputation.observedTransactionalVolume, indexed ? [{ currency: "DEM", amount: "2" }] : [], c.name);
    });
  } finally {
    store.clear(); for (const [key, raw] of original) store.set(key, raw);
    if (originalSnapshots === undefined) delete process.env.DACS_RECIPE_SNAPSHOTS; else process.env.DACS_RECIPE_SNAPSHOTS = originalSnapshots;
    if (originalPolicies === undefined) delete process.env.DACS_RECIPE_POLICIES; else process.env.DACS_RECIPE_POLICIES = originalPolicies;
  }
});

// CF-1 rejects these numbers before signing; pin the validator independently as well.
test("payment chain IDs reject fractional and unsafe numbers before canonical signing", () => {
  const ref = { kind: "evm", chainId: 0, txHash: "ab".repeat(32) };
  for (const chainId of [0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])
    assert.equal(paymentTxRefsOk({ phase: "pay-evm-erc20", outcome: "success", paymentTxRefs: [{ ...ref, chainId }] }), false);
  assert.equal(paymentTxRefsOk({ phase: "pay-evm-erc20", outcome: "success", paymentTxRefs: [ref] }), true);
});


test("registration-side holder binding overflow independently leaves its side indeterminate", async () => {
  const original = new Map(store);
  try {
    // Distinct signed bindings share one native copy, so the separate eight-fetch
    // budget cannot mask a missing sticky-overflow guard.
    const flood = Array.from({ length: 33 }, (_, index) =>
      binding("buyer", at(5), BUYER, { anchorTx: index.toString(16).padStart(64, "0") }));
    const seller = await indexSeller([...flood, binding("seller", at(6), SELLER)]);
    assert.equal(seller.deals[0].refsVerified, false);
    assert.equal(seller.deals[0].reputationEligible, false);
    assert.equal(seller.reputation.completed, 0);
    assert.deepEqual(seller.reputation.observedTransactionalVolume, []);
  } finally { store.clear(); for (const [key, value] of original) store.set(key, value); }
});

test("storage faults inside deal processing abort index publication instead of returning a partial seller", async () => {
  const previous = loadCatalog();
  const prepare = Database.prototype.prepare;
  for (const code of ["EIO", "ENOSPC", "EROFS", "EACCES", "SQLITE_FULL", "SQLITE_IOERR"]) {
    const error = Object.assign(new Error("injected anchor-time read failure"), { code });
    Database.prototype.prepare = function (this: Database.Database, sql: string) {
      if (sql.includes("SELECT anchor_time FROM artifacts")) throw error;
      return prepare.call(this, sql);
    } as typeof prepare;
    try { await assert.rejects(indexSeller(holders()), (actual) => actual === error); }
    finally { Database.prototype.prepare = prepare; }
    assert.deepEqual(loadCatalog(), previous);
  }
});


test("failure-only payment reference fields stay optional without establishing successful settlement", () => {
  const hash = "ab".repeat(32);
  const optional = [
    { phase: "pay-ap2", ref: { kind: "ap2", mandateId: "mandate", providerRef: "receipt", protocolVersion: "1" } },
    { phase: "pay-cross-chain-liquidity-tank", ref: { kind: "liquidity-tank", bridgeId: "bridge", sourceChainId: 0, destChainId: 1, lockTxHash: hash } },
  ];
  for (const { phase, ref } of optional) {
    assert.equal(paymentTxRefsOk({ phase, outcome: "failure", paymentTxRefs: [ref] }), true);
    assert.equal(paymentTxRefsOk({ phase, outcome: "success", paymentTxRefs: [ref] }), false);
  }
  for (const [kind, field] of [["htlc-lock", "lockTxHash"], ["htlc-reveal", "revealTxHash"], ["htlc-claim", "claimTxHash"], ["htlc-refund", "refundTxHash"]]) {
    const ref = { kind, chainId: 0, contractAddress: "contract", [field]: hash };
    assert.equal(paymentTxRefsOk({ phase: "pay-cross-chain-htlc", outcome: "failure", paymentTxRefs: [ref] }), true);
    assert.equal(paymentTxRefsOk({ phase: "pay-cross-chain-htlc", outcome: "success", paymentTxRefs: [ref] }), false);
  }
});

test("repeated deliveries require every evidence outcome to succeed before graph and catalog admission", async () => {
  const original = new Map(store);
  try {
    for (const failure of [false, true]) {
      const pipeline = [...listingScope.pipeline as Obj[], { kind: "deliver-attested-payload" }, { kind: "deliver-attested-payload" }];
      const listedScope = { ...listingScope, pipeline };
      const listed = { ...listedScope, signature: signedWith(listedScope, "listing", SELLER) };
      const pinned = { ...listingRef, contentHash: artifactHash(listed, "listing") };
      const agreedScope = { ...agreementScope, listingRef: pinned };
      const agreed = { ...agreedScope, signatures: [signedWith(agreedScope, "agreement", BUYER, "party"), signedWith(agreedScope, "agreement", SELLER, "party")] };
      const deliveryRefs = [0, 1].map((i) => {
        const raw: Obj = { evidenceVersion: "1", jobId: JOB, phase: "deliver-attested-payload", outcome: failure && i === 1 ? "failure" : "success", observedAt: 101 + i };
        const signed = { ...raw, signature: signedWith(raw, "evidence", SELLER) };
        store.set(at(50 + i), signed); return refTo(at(50 + i), signed, "evidence");
      });
      const scope = bundleScope({ listingRef: pinned, agreementRef: refTo(at(2), agreed, "agreement"),
        phaseSummary: pipeline.map((phase, index) => ({ index, kind: phase.kind, outcome: "ok" })),
        settlementEvidence: [refTo(at(3), evidence, "evidence"), ...deliveryRefs] });
      store.set(at(1), listed).set(at(2), agreed).set(at(20), copy("buyer", scope)).set(at(21), copy("seller", scope));
      const graph = await buildCurrentEvidenceGraph(at(20), { readSettlementNode: nativeNodeFixture(() => store.values()), read: async (ref) => store.get(ref) ?? null,
        readAnchorRecord: async (ref) => ({ data: store.get(ref)!, programName: OPAQUE_PROGRAM_NAME }), resolveListing: async () => ({ locator: at(1), raw: listed }) });
      assert.equal(graph.signaturesVerified, true);
      assert.equal(graph.ok, false, graph.reason);
      const seller = await indexSeller([binding("buyer", at(20), BUYER), binding("seller", at(21), SELLER)]);
      assert.equal(seller.deals[0].refsVerified, false);
      assert.equal(seller.deals[0].reputationEligible, false);
      assert.equal(seller.reputation.completed, 0);
      assert.deepEqual(seller.reputation.observedTransactionalVolume, []);
    }
  } finally { store.clear(); for (const [key, raw] of original) store.set(key, raw); }
});

test("terminal failure classification preserves neutral substrate standing in both signed copies", async (t) => {
  const original = new Map(store);
  try {
    for (const errorClass of ["permanent", "transient", "counterparty", "substrate", "settlement-atomicity"]) await t.test(errorClass, async () => {
      const failedScope: Obj = { ...evidenceScope, outcome: "failure" }; delete failedScope.settlementFinality;
      const failed = { ...failedScope, signature: signedWith(failedScope, "evidence", SELLER) };
      const neutral = errorClass === "substrate";
      const counterparty = errorClass === "counterparty" || errorClass === "settlement-atomicity";
      const scope = bundleScope({ outcome: neutral ? "failed-substrate" : counterparty ? "failed-counterparty" : "failed-perm", phaseSummary: [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" },
        { index: 1, kind: "commit-agreement", outcome: "ok" }, { index: 2, kind: "pay-dem", outcome: "fail", errorClass }], settlementEvidence: [refTo(at(50), failed, "evidence")] });
      store.set(at(1), listing).set(at(2), agreement).set(at(50), failed).set(at(20), copy("buyer", scope)).set(at(21), copy("seller", { ...scope, outcome: neutral ? "failed-substrate" : counterparty ? "failed-perm" : "failed-counterparty" }));
      const graph = await buildCurrentEvidenceGraph(at(20), { readSettlementNode: nativeNodeFixture(() => store.values()), read: async (ref) => store.get(ref) ?? null,
        readAnchorRecord: async (ref) => ({ data: store.get(ref)!, programName: OPAQUE_PROGRAM_NAME }), resolveListing: async () => ({ locator: at(1), raw: listing }) });
      assert.equal(graph.ok, true, `${errorClass}: ${graph.reason}`);
      const seller = await indexSeller([binding("buyer", at(20), BUYER), binding("seller", at(21), SELLER)]);
      assert.equal(seller.deals[0].refsVerified, true, errorClass);
      assert.equal(seller.deals[0].fullSignatureStanding, true, errorClass);
      if (neutral) {
        assert.equal(seller.deals[0].sellerOutcome, "failed-substrate");
        assert.equal(seller.reputation.completionRate, null);
        assert.equal(seller.reputation.counterpartyAdjustedCompletionRate, null);
        // Replay the reviewer's mutually consistent, party-attributed substrate copies.
        const goodBuyer = store.get(at(20))!, goodSeller = store.get(at(21))!;
        store.set(at(20), copy("buyer", { ...scope, outcome: "failed-perm" }));
        store.set(at(21), copy("seller", { ...scope, outcome: "failed-counterparty" }));
        const misattributed = await indexSeller([binding("buyer", at(20), BUYER), binding("seller", at(21), SELLER)]);
        assert.equal(misattributed.deals[0].refsVerified, false);
        assert.equal(misattributed.deals[0].reputationEligible, false);
        store.set(at(20), goodBuyer).set(at(21), goodSeller);
      }
      for (const badRole of ["buyer", "seller"] as const) {
        const badOutcome = neutral ? (badRole === "buyer" ? "failed-perm" : "failed-counterparty") : "failed-substrate";
        const good = store.get(at(badRole === "buyer" ? 20 : 21))!;
        store.set(at(badRole === "buyer" ? 20 : 21), copy(badRole, { ...signedScope(good, "bundle"), outcome: badOutcome }));
        // Check the single graph too: differing copies must not be the reason this is rejected.
        const badGraph = await buildCurrentEvidenceGraph(at(badRole === "buyer" ? 20 : 21), {
          read: async (ref) => store.get(ref) ?? null,
          readAnchorRecord: async (ref) => ({ data: store.get(ref)!, programName: OPAQUE_PROGRAM_NAME }),
          resolveListing: async () => ({ locator: at(1), raw: listing }),
        });
        assert.equal(badGraph.signaturesVerified, true);
        assert.equal(badGraph.ok, false, `${errorClass}: ${badRole} graph misclassification`);
        const rejected = await indexSeller([binding("buyer", at(20), BUYER), binding("seller", at(21), SELLER)]);
        assert.equal(rejected.deals[0].refsVerified, false, `${errorClass}: ${badRole} misclassification`);
        assert.equal(rejected.deals[0].reputationEligible, false);
        store.set(at(badRole === "buyer" ? 20 : 21), good);
      }
    });
  } finally { store.clear(); for (const [key, raw] of original) store.set(key, raw); }
});

test("HTLC success rejects a foreign kind even with a hash under the undefined lookup key", () => {
  const hash = "ab".repeat(32);
  const refs = [["htlc-lock", "lockTxHash"], ["htlc-reveal", "revealTxHash"], ["htlc-claim", "claimTxHash"]].map(([kind, field]) => ({ kind, chainId: 0, contractAddress: "contract", [field]: hash }));
  assert.equal(paymentTxRefsOk({ phase: "pay-cross-chain-htlc", outcome: "success", paymentTxRefs: refs }), true);
  assert.equal(paymentTxRefsOk({ phase: "pay-cross-chain-htlc", outcome: "success", paymentTxRefs: [...refs, { kind: "foreign", chainId: 0, contractAddress: "contract", undefined: hash }] }), false);
});

test("storage payload and ACL verification gates catalog completion and volume", async (t) => {
  const original = new Map(store);
  const payload = { report: "catalog delivery" };
  const signedPayload = { ...payload, signature: "original", signatures: ["original"] };
  const signedPayloadHash = createHash("sha256").update(JSON.stringify(signedPayload)).digest("hex");
  const cases: Array<{ name: string; accessModel?: string; evidence?: Obj; metadata?: Obj; payload?: Obj; expected?: boolean }> = [
    { name: "verified public payload", expected: true },
    { name: "verified payload includes both signature fields", payload: signedPayload, evidence: { deliverableContentHash: signedPayloadHash }, expected: true },
    { name: "changed signature at fixed payload hash", payload: { ...signedPayload, signature: "tampered" }, evidence: { deliverableContentHash: signedPayloadHash } },
    { name: "changed signatures at fixed payload hash", payload: { ...signedPayload, signatures: ["tampered"] }, evidence: { deliverableContentHash: signedPayloadHash } },
    { name: "artifact hash cannot hide changed signature", payload: { ...signedPayload, signature: "tampered" } },
    { name: "artifact hash cannot hide changed signatures", payload: { ...signedPayload, signatures: ["tampered"] } },
    // The catalog installs no authenticated restricted reader, so even a correct buyer-only ACL is unverifiable.
    { name: "buyer-only payload without an authenticated restricted reader", accessModel: "buyer-only", metadata: { acl: { mode: "restricted", allowed: [`0x${dids[BUYER].slice(-64)}`] } } },
    { name: "public payload the buyer is blacklisted from", metadata: { acl: { mode: "public", blacklisted: [`0x${dids[BUYER].slice(-64)}`] } } },
    { name: "owner-mode payload", metadata: { acl: { mode: "owner" } } },
    // The pinned node's read rule for the buyer (ac8f45f checkReadPermission) compares exact strings,
    // honours the owner and lets a group with read permission grant access.
    { name: "an uppercase blacklist spelling does not stop the buyer", metadata: { acl: { mode: "public", blacklisted: [`0x${dids[BUYER].slice(-64).toUpperCase()}`] } }, expected: true },
    { name: "an uppercase allowed spelling does not admit the buyer", metadata: { acl: { mode: "restricted", allowed: [`0x${dids[BUYER].slice(-64).toUpperCase()}`] } } },
    { name: "a group with read permission admits the buyer", metadata: { acl: { mode: "restricted", groups: { buyers: { members: [`0x${dids[BUYER].slice(-64)}`], permissions: ["read"] } } } }, expected: true },
    { name: "owner-mode payload the buyer owns", metadata: { owner: `0x${dids[BUYER].slice(-64)}`, acl: { mode: "owner" } }, expected: true },
    { name: "missing hash", evidence: { deliverableContentHash: undefined } },
    { name: "wrong hash", evidence: { deliverableContentHash: "0".repeat(64) } },
    { name: "absent anchor", evidence: { deliverableAnchor: undefined } },
    { name: "private delivery downgraded to public", accessModel: "buyer-only" },
    { name: "private delivery allows another buyer", accessModel: "buyer-only", metadata: { acl: { mode: "restricted", allowed: [`0x${dids[OUTSIDER].slice(-64)}`] } } },
    { name: "node denies private read", accessModel: "buyer-only", metadata: { unreadable: true } },
    { name: "sealed payload cannot be publicly verified", accessModel: "encrypt-to-buyer" },
  ];
  try {
    for (const c of cases) await t.test(c.name, async () => {
      store.clear(); for (const [key, raw] of original) store.set(key, raw);
      const deliverable = { kind: "storage-program", accessModel: c.accessModel ?? "public" };
      const pipeline = listingScope.pipeline as Obj[];
      const listedScope = { ...listingScope, offering: { ...listingScope.offering as Obj, deliverable }, pipeline };
      const listed = { ...listedScope, signature: signedWith(listedScope, "listing", SELLER) };
      const pinned = { ...listingRef, contentHash: artifactHash(listed, "listing") };
      const agreedScope = { ...agreementScope, listingRef: pinned, terms: { ...agreementScope.terms as Obj,
        deliverable: { deliverableType: "storage-program", hash: contentHash(deliverable) } } };
      const agreed = { ...agreedScope, signatures: [signedWith(agreedScope, "agreement", BUYER, "party"), signedWith(agreedScope, "agreement", SELLER, "party")] };
      const deliveredScope: Obj = { evidenceVersion: "1", jobId: JOB, phase: "deliver-storage-program", outcome: "success", observedAt: 101,
        deliverableContentHash: contentHash(payload), deliverableAnchor: { kind: "storage-program", locator: at(51) }, ...c.evidence };
      for (const key of Object.keys(deliveredScope)) if (deliveredScope[key] === undefined) delete deliveredScope[key];
      const delivered = { ...deliveredScope, signature: signedWith(deliveredScope, "evidence", SELLER) };
      const scope = bundleScope({ listingRef: pinned, agreementRef: refTo(at(2), agreed, "agreement"),
        phaseSummary: pipeline.map((phase, index) => ({ index, kind: phase.kind, outcome: "ok" })),
        settlementEvidence: [refTo(at(3), evidence, "evidence"), refTo(at(50), delivered, "evidence")] });
      store.set(at(1), listed).set(at(2), agreed).set(at(50), delivered).set(at(51), c.payload ?? payload).set(at(20), copy("buyer", scope)).set(at(21), copy("seller", scope));
      const metadata = { [at(51)]: { acl: { mode: "public" }, ...c.metadata } };
      const seller = await indexSeller([binding("buyer", at(20), BUYER), binding("seller", at(21), SELLER)], [], "demos-native:DEM", metadata);
      assert.equal(seller.deals[0].refsVerified, c.expected ?? false);
      assert.equal(seller.deals[0].reputationEligible, c.expected ?? false);
      assert.equal(seller.reputation.completed, c.expected ? 1 : 0);
      assert.deepEqual(seller.reputation.observedTransactionalVolume, c.expected ? [{ currency: "DEM", amount: "2" }] : []);
    });
  } finally { store.clear(); for (const [key, raw] of original) store.set(key, raw); }
});


test("native transaction and block reads gate reference verification, completion and volume", async (t) => {
  const fixture = nativeNodeFixture(() => store.values());
  const cases: Record<string, (message: string, value: any) => any> = {
    "nonexistent transaction": (m, v) => m === "getTxByHash" ? null : v,
    "pending transaction": (m, v) => m === "getTxByHash" ? { ...v, status: "pending" } : v,
    "wrong block number": (m, v) => m === "getTxByHash" ? { ...v, blockNumber: 2 } : v,
    "wrong recipient": (m, v) => m === "getTxByHash" ? { ...v, content: { ...v.content, to: `0x${"9".repeat(64)}` } } : v,
    "wrong amount": (m, v) => m === "getTxByHash" ? { ...v, content: { ...v.content, amount: "1" } } : v,
    "missing block membership": (m, v) => m === "getBlockByNumber" ? { ...v, content: { ordered_transactions: [] } } : v,
    "unavailable block": (m, v) => m === "getBlockByNumber" ? null : v,
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async () => {
    const seller = await indexSeller(holders(), [], "pay-dem", {}, async (m, d) => change(m, await fixture(m, d)));
    assert.equal(seller.deals[0].refsVerified, false);
    assert.equal(seller.deals[0].reputationEligible, false);
    assert.equal(seller.reputation.completed, 0);
    assert.deepEqual(seller.reputation.observedTransactionalVolume, []);
  });
});

/** Re-sign every reference so a regression reaches semantic admission, not stale hashes. */
function installListedCase(change: (scope: Obj) => void, changeBundle: (scope: Obj) => void = () => {}, changeAgreement: (scope: Obj) => void = () => {}) {
  const listedScope = structuredClone(listingScope); change(listedScope);
  const listed = { ...listedScope, signature: signedWith(listedScope, "listing", SELLER) };
  const pinned = { ...listingRef, contentHash: artifactHash(listed, "listing") };
  const agreedScope: Obj = { ...agreementScope, listingRef: pinned, terms: { ...agreementScope.terms as Obj,
    rail: (listedScope.acceptedRails as Obj[])[0],
    deliverable: { deliverableType: (listedScope.offering as Obj).deliverable && ((listedScope.offering as Obj).deliverable as Obj).kind,
      hash: contentHash((listedScope.offering as Obj).deliverable as Obj) } } };
  changeAgreement(agreedScope);
  const agreed = { ...agreedScope, signatures: [signedWith(agreedScope, "agreement", BUYER, "party"), signedWith(agreedScope, "agreement", SELLER, "party")] };
  const scope = bundleScope({ listingRef: pinned, agreementRef: refTo(at(2), agreed, "agreement") }); changeBundle(scope);
  store.set(at(1), listed).set(at(2), agreed).set(at(5), copy("buyer", scope)).set(at(6), copy("seller", scope));
  return listed;
}
async function currentGraph(listed: Obj) {
  return buildCurrentEvidenceGraph(at(5), { readSettlementNode: nativeNodeFixture(() => store.values()),
    read: async (locator) => store.get(locator) ?? null,
    readAnchorRecord: async (locator) => ({ data: store.get(locator)!, acl: { mode: "public" },
      programName: OPAQUE_PROGRAM_NAME }),
    resolveListing: async () => ({ locator: at(1), raw: listed }) });
}
async function assertUncounted() {
  const seller = await indexSeller(holders());
  assert.equal(seller.deals[0].refsVerified, false);
  assert.equal(seller.reputation.completed, 0);
  assert.deepEqual(seller.reputation.observedTransactionalVolume, []);
}

test("PIPE-1/VPC deficient signed listings never establish graph or catalog completion", async () => {
  const original = new Map(store);
  try {
    for (const change of [
      (s: Obj) => { s.pipeline = (s.pipeline as Obj[]).slice(0, 3); },
      (s: Obj) => { (s.pipeline as Obj[]).splice(1, 0, { kind: "vet-credentials" }); },
      (s: Obj) => { (s.pipeline as Obj[]).push({ kind: "vet-credentials" }); },
    ]) {
      const listed = installListedCase(change);
      const graph = await currentGraph(listed);
      assert.equal(graph.ok, false); assert.match(graph.reason!, /listing reference failed/);
      await assertUncounted();
    }
  } finally { store.clear(); for (const [key, raw] of original) store.set(key, raw); }
});

test("hybrid and legacy listings cannot bypass current graph and catalog admission", async () => {
  const original = new Map(store);
  const compatibility = { agentId: dids[SELLER], serviceId: "binding-rules", name: "legacy", description: "legacy",
    claimRequirements: [], supportedNegotiation: ["negotiate-fixed-price"], supportedPaymentRails: ["demos-native:DEM"], supportedDelivery: ["deliver-storage-program"] };
  try {
    const control = installListedCase((scope) => Object.assign(scope, compatibility));
    assert.equal((await currentGraph(control)).ok, true);
    assert.equal((await indexSeller(holders())).reputation.completed, 1);
    // Object-valued parameters on non-pay phases stay in the signed scope (#98, dab2497),
    // for hybrid listings exactly as for current ones.
    for (const change of [
      (scope: Obj) => { (scope.pipeline as Obj[])[0].parameters = {}; },
      (scope: Obj) => { (scope.pipeline as Obj[])[1].parameters = { unexpected: true }; },
    ]) {
      const listed = installListedCase((scope) => { Object.assign(scope, compatibility); change(scope); });
      const graph = await currentGraph(listed);
      assert.equal(graph.ok, true, graph.reason);
      assert.equal((await indexSeller(holders())).reputation.completed, 1);
    }
    for (const change of [
      (scope: Obj) => { scope.pipeline = (scope.pipeline as Obj[]).slice(0, 3); },
      (scope: Obj) => { (scope.pipeline as Obj[]).push({ kind: "vet-credentials" }); },
      (scope: Obj) => { ((scope.seller as Obj).identity as Obj).bundleVersion = "2"; },
      (scope: Obj) => { (scope.pipeline as Obj[])[0].parameters = []; },
      (scope: Obj) => { (scope.pipeline as Obj[])[1].parameters = "unexpected"; },
      (scope: Obj) => { delete scope.dacsVersion; },
    ]) {
      const listed = installListedCase((scope) => { Object.assign(scope, compatibility); change(scope); });
      const graph = await currentGraph(listed);
      assert.equal(graph.ok, false);
      assert.equal(graph.reason, "listing reference failed");
      await assertUncounted();
    }
  } finally { store.clear(); for (const [key, raw] of original) store.set(key, raw); }
});

test("payment phase, anchor binding, agreement and admitted policy must choose the same rail", async () => {
  const original = new Map(store);
  try {
    // The agreement takes the first accepted rail, DEM. Its own session is refused when the phase pays
    // another rail; the listing that also accepts x402 is refused for every session, since x402 is a
    // choice the pay-dem phase can never settle.
    for (const [accepted, phaseRail, reason] of [
      [["demos-native:DEM"], "demos-native:DEM", undefined],
      [["demos-native:DEM", "x402:default"], "x402:default", "payment phase rail does not match the agreement rail"],
      [["demos-native:DEM", "x402:default"], "demos-native:DEM", "session verification is indeterminate for every outcome on this listing: accepted rail " +
        `${JSON.stringify({ railId: "x402:default" })} at the listed price: payment phase rail does not match the agreement rail`],
    ] as const) {
      const listed = installListedCase((scope) => {
        scope.acceptedRails = accepted.map((railId) => ({ railId }));
        (scope.pipeline as Obj[])[2].parameters = { rail: phaseRail };
      });
      const graph = await currentGraph(listed);
      const expected = reason === undefined;
      assert.equal(graph.ok, expected, graph.reason);
      assert.equal(graph.reason, reason);
      const seller = await indexSeller(holders());
      assert.equal(seller.deals[0].refsVerified, expected);
      assert.equal(seller.reputation.completed, expected ? 1 : 0);
      assert.deepEqual(seller.reputation.observedTransactionalVolume, expected ? [{ currency: "DEM", amount: "2" }] : []);
    }
  } finally { store.clear(); for (const [key, raw] of original) store.set(key, raw); }
});

test("paid completion requires an authenticated matching versioned live rail definition", async () => {
  const original = new Map(store), policy = process.env.DACS_RAIL_SNAPSHOTS!;
  const snapshot = JSON.parse(policy);
  try {
    const variants = [[], [{ ...snapshot[0], registryVersion: 999 }],
      ...[{ availability: "disabled" }, { phaseHandler: "pay-x402" },
        { parameters: { network: "unexpected-network" } }, { asset: { kind: "native-dem", symbol: "USD", decimals: 9 } }, { network: { kind: "evm", chainId: 1 } }]
        .map((change) => [{ ...snapshot[0], rails: [{ ...snapshot[0].rails[0], ...change }] }])];
    for (const value of variants) {
      process.env.DACS_RAIL_SNAPSHOTS = JSON.stringify(value);
      const graph = await currentGraph(listing);
      assert.equal(graph.ok, false, JSON.stringify(value)); assert.match(graph.reason!, /pinned rail/);
      await assertUncounted();
    }
    // PA-1: each pinned field of the native DEM definition is checked on its own.
    const mismatch = "payment verification is indeterminate: pinned rail handler, asset or network does not match";
    for (const change of [{ railType: "evm" }, { asset: { kind: "erc20", symbol: "DEM", decimals: 9 } }, { asset: { kind: "native-dem", symbol: "DEM", decimals: 18 } },
      { asset: undefined }, { network: undefined }]) {
      process.env.DACS_RAIL_SNAPSHOTS = JSON.stringify([{ ...snapshot[0], rails: [{ ...snapshot[0].rails[0], ...change }] }]);
      assert.equal((await currentGraph(listing)).reason, mismatch, JSON.stringify(change));
      await assertUncounted();
    }
    process.env.DACS_RAIL_SNAPSHOTS = policy;
    // The live DEM definition settles only through its pay-dem handler, whatever phase names the rail:
    // a session that committed to it on a pay-x402 phase is refused before its payment.
    const x402Phase = installListedCase((s) => { (s.pipeline as Obj[])[2] = { kind: "pay-x402", parameters: { rail: "demos-native:DEM" } }; }, (s) => {
      s.settlementEvidence = []; s.ratingRefs = [];
      s.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" }];
    });
    for (const [locator, role, outcome] of [[at(5), "buyer", "aborted-by-other"], [at(6), "seller", "aborted-by-self"]]) {
      const scope = signedScope(store.get(locator)!, "bundle"); scope.outcome = outcome; store.set(locator, copy(role, scope));
    }
    assert.equal((await currentGraph(x402Phase)).reason, mismatch);
    await assertUncounted();
    store.clear(); for (const [key, raw] of original) store.set(key, raw);
    // A definition identical to native DEM except for its railId is not the native DEM rail.
    process.env.DACS_RAIL_SNAPSHOTS = JSON.stringify([{ ...snapshot[0], rails: [{ ...snapshot[0].rails[0], railId: "demos-native:DEM-alt" }] }]);
    const altRail = installListedCase((s) => { s.acceptedRails = [{ railId: "demos-native:DEM-alt" }]; (s.pipeline as Obj[])[2].parameters = { rail: "demos-native:DEM-alt" }; });
    assert.equal((await currentGraph(altRail)).reason, mismatch);
    await assertUncounted();
    store.clear(); for (const [key, raw] of original) store.set(key, raw);
    // A version-0 definition, or two identical definitions, selects no single pinned rail.
    for (const rails of [[{ ...snapshot[0].rails[0], railVersion: 0 }], [snapshot[0].rails[0], snapshot[0].rails[0]]]) {
      process.env.DACS_RAIL_SNAPSHOTS = JSON.stringify([{ ...snapshot[0], rails }]);
      assert.equal((await currentGraph(listing)).reason, "payment verification is indeterminate: authenticated pinned rail definition is unavailable");
    }
    // Two snapshots for the session's registryVersion are ambiguous, whichever comes first (code review P2-4).
    for (const snapshots of [[snapshot[0], { ...snapshot[0], rails: [] }], [{ ...snapshot[0], rails: [] }, snapshot[0]], [snapshot[0], snapshot[0]]]) {
      process.env.DACS_RAIL_SNAPSHOTS = JSON.stringify(snapshots);
      assert.equal((await currentGraph(listing)).reason, "payment verification is indeterminate: authenticated pinned rail definition is unavailable");
      await assertUncounted();
    }
    process.env.DACS_RAIL_SNAPSHOTS = policy;
    const unknownRegistry = installListedCase(() => {}, (s) => { s.railRegistryVersion = 999; });
    assert.match((await currentGraph(unknownRegistry)).reason!, /pinned rail definition is unavailable/);
    await assertUncounted();
    for (const rail of [{ railId: "x402:default", railVersion: 999 }, { railId: "demos-native:DEM", railVersion: 999 }]) {
      const listed = installListedCase((s) => { s.acceptedRails = [rail]; (s.pipeline as Obj[])[2].parameters = { rail: rail.railId }; });
      assert.equal((await currentGraph(listed)).ok, false); await assertUncounted();
    }
  } finally { process.env.DACS_RAIL_SNAPSHOTS = policy; store.clear(); for (const [key, raw] of original) store.set(key, raw); }
});

test("attested payload and entitlement assertions require authoritative delivery adapters", async () => {
  const original = new Map(store);
  try {
    for (const kind of ["attested-payload", "entitlement"]) for (const proof of [{},
      { deliverableContentHash: "0".repeat(64), deliverableAnchor: { kind: "storage-program", locator: at(61) } },
      { grantee: dids[OUTSIDER], verificationMethod: { kind: "wrong-method" }, grantRef: at(99) }]) {
      const listed = installListedCase((s) => {
        (s.offering as Obj).deliverable = kind === "entitlement" ? { kind, durationSec: 60, renewable: false } : { kind, payloadFormat: "application/json" };
        (s.pipeline as Obj[])[3] = { kind: `deliver-${kind}` };
      }, (s) => { (s.phaseSummary as Obj[])[3].kind = `deliver-${kind}`; });
      const baseDelivery = signedScope(delivery, "evidence"); delete baseDelivery.deliverableContentHash; delete baseDelivery.deliverableAnchor;
      const deliveryScope = { ...baseDelivery, phase: `deliver-${kind}`, ...proof };
      const delivered = { ...deliveryScope, signature: signedWith(deliveryScope, "evidence", SELLER) };
      store.set(at(60), delivered);
      for (const [locator, role] of [[at(5), "buyer"], [at(6), "seller"]]) {
        const scope = signedScope(store.get(locator)!, "bundle"); scope.settlementEvidence = [refTo(at(3), evidence, "evidence"), refTo(at(60), delivered, "evidence")];
        store.set(locator, copy(role, scope));
      }
      const graph = await currentGraph(listed);
      assert.equal(graph.ok, false); assert.match(graph.reason!, /delivery verification is indeterminate/);
      await assertUncounted();
    }
  } finally { store.clear(); for (const [key, raw] of original) store.set(key, raw); }
});

test("signed pre-commit failures count in completion denominators without volume", async () => {
  const original = new Map(store);
  try {
    for (const kind of ["negotiate-fixed-price", "commit-agreement"]) {
      const listed = installListedCase(() => {}, (s) => {
        delete s.agreementRef; s.settlementEvidence = []; s.ratingRefs = [];
        s.phaseSummary = [{ index: kind === "commit-agreement" ? 1 : 0, kind, outcome: "fail", errorClass: "permanent" }];
      });
      for (const [locator, role, outcome] of [[at(5), "buyer", "failed-counterparty"], [at(6), "seller", "failed-perm"]]) {
        const scope = signedScope(store.get(locator)!, "bundle"); scope.outcome = outcome; store.set(locator, copy(role, scope));
      }
      const graph = await currentGraph(listed); assert.equal(graph.ok, true, graph.reason);
      const seller = await indexSeller(holders());
      assert.equal(seller.deals[0].refsVerified, true); assert.equal(seller.reputation.bundleCount, 1);
      assert.equal(seller.reputation.completed, 0); assert.equal(seller.reputation.completionRate, 0);
      assert.deepEqual(seller.reputation.observedTransactionalVolume, []);
    }
  } finally { store.clear(); for (const [key, raw] of original) store.set(key, raw); }
});

test("§10.5.1: what the deployment cannot verify excludes every outcome on the listing, never only completions", async (t) => {
  // These checks used to run only once a session paid, delivered or committed, so a
  // seller's verified paid completions dropped out while its signed pre-commit failures still
  // counted, publishing it at 0%. Each limitation now excludes the completion and the failure alike.
  const original = new Map(store), policy = process.env.DACS_RAIL_SNAPSHOTS!;
  const failBeforeCommit = (index: number, kind: string) => (s: Obj) => {
    delete s.agreementRef; s.settlementEvidence = []; s.ratingRefs = [];
    s.phaseSummary = [{ index, kind, outcome: "fail", errorClass: "permanent" }];
  };
  const asSellerFault = () => {
    for (const [locator, role, outcome] of [[at(5), "buyer", "failed-counterparty"], [at(6), "seller", "failed-perm"]]) {
      const scope = signedScope(store.get(locator)!, "bundle"); scope.outcome = outcome; store.set(locator, copy(role, scope));
    }
  };
  const published = async () => {
    const seller = await indexSeller(holders());
    return { verified: seller.deals[0].refsVerified, bundleCount: seller.reputation.bundleCount, completionRate: seller.reputation.completionRate };
  };
  const excluded = { verified: false, bundleCount: 0, completionRate: null };
  const cases: Array<[string, (s: Obj) => void, [number, string], (() => void)?]> = [
    ["a non-DEM payment rail", (s) => { s.acceptedRails = [{ railId: "x402:default" }]; (s.pipeline as Obj[])[2] = { kind: "pay-x402", parameters: { rail: "x402:default" } }; },
      [0, "negotiate-fixed-price"]],
    ["vetting without a historical challenge resolver", (s) => { (s.pipeline as Obj[]).unshift({ kind: "vet-credentials" }); }, [0, "vet-credentials"]],
    ["no live rail snapshot for the session's registry version", () => {}, [0, "negotiate-fixed-price"],
      () => { process.env.DACS_RAIL_SNAPSHOTS = "[]"; }],
    ["commitment-time bounds", (s) => { s.validity = { ...(s.validity as Obj), notAfter: 4_102_444_800_000 }; }, [0, "negotiate-fixed-price"]],
    ["storage delivery encrypted to the buyer", (s) => { ((s.offering as Obj).deliverable as Obj).accessModel = "encrypt-to-buyer"; }, [1, "commit-agreement"]],
    ["an entitlement delivery", (s) => { (s.offering as Obj).deliverable = { kind: "entitlement", durationSec: 60, renewable: false }; (s.pipeline as Obj[])[3] = { kind: "deliver-entitlement" }; },
      [0, "negotiate-fixed-price"]],
    // The pinned node denies anonymous restricted reads (ac8f45f checkReadPermission) and production
    // installs no authenticated restricted reader, so a buyer-only payload is unreadable here.
    ["buyer-only delivery without an authenticated restricted reader", (s) => { ((s.offering as Obj).deliverable as Obj).accessModel = "buyer-only"; },
      [1, "commit-agreement"]],
    // An agreement may select any rail the listing accepts, and a pre-commit failure never says which.
    ["an accepted DEM rail version with no installed definition", (s) => { s.acceptedRails = [{ railId: "demos-native:DEM", railVersion: 2 }]; },
      [0, "negotiate-fixed-price"]],
    // Each order matters: the agreement here takes the first accepted rail, so one completion would
    // verify on DEM and the other could never settle, while the pipeline pays only through pay-dem.
    ["a non-DEM rail accepted after DEM on a pay-dem pipeline", (s) => { s.acceptedRails = [{ railId: "demos-native:DEM" }, { railId: "x402:default" }]; },
      [0, "negotiate-fixed-price"]],
    ["a non-DEM rail accepted before DEM on a pay-dem pipeline", (s) => { s.acceptedRails = [{ railId: "x402:default" }, { railId: "demos-native:DEM" }]; },
      [0, "negotiate-fixed-price"]],
    ["a listed price the DEM rail cannot settle", (s) => { s.pricing = { kind: "fixed", price: { amount: "2", currency: "USD" } }; }, [0, "negotiate-fixed-price"]],
    // Fixed-price negotiation of a negotiable band makes every agreement a fixed-price one, which has
    // no settlement semantics on a negotiable listing.
    ["negotiate-fixed-price on a negotiable listing", (s) => { s.pricing = { kind: "negotiable", bandCenter: { amount: "2", currency: "DEM" }, minPct: 10, maxPct: 10 }; },
      [0, "negotiate-fixed-price"]],
    // An RFQ step enabling the fixed-price fallback lets any session settle on a fixed-price agreement,
    // which has no settlement semantics on a negotiable listing; the completion here is one.
    ["an RFQ step that enables the fixed-price fallback on a negotiable listing", (s) => {
      s.pricing = { kind: "negotiable", bandCenter: { amount: "2", currency: "DEM" }, minPct: 10, maxPct: 10 };
      (s.pipeline as Obj[])[0] = { kind: "negotiate-rfq", parameters: { maxTurns: 6, timeoutSec: 60, fixedPriceFallback: true } };
    }, [0, "negotiate-rfq"]],
    // DACS-3 §8.8 declares the fallback "in the pipeline step"; the step member enables it the same way (code review P3-2).
    ["an RFQ step that declares the fixed-price fallback on the step itself", (s) => {
      s.pricing = { kind: "negotiable", bandCenter: { amount: "2", currency: "DEM" }, minPct: 10, maxPct: 10 };
      (s.pipeline as Obj[])[0] = { kind: "negotiate-rfq", fixedPriceFallback: true, parameters: { maxTurns: 6, timeoutSec: 60 } };
    }, [0, "negotiate-rfq"]],
    // DACS-4 §9.6.1: above the 128 KB cap the payload MUST be an extended pointer, whose external
    // cleartext this deployment cannot read; the honest completion delivers that pointer.
    ["a declared payload above the inline storage cap", (s) => { ((s.offering as Obj).deliverable as Obj).expectedSizeBytes = 500_000; }, [1, "commit-agreement"],
      () => { store.set(at(61), { externalUrl: "https://payload.example/report", externalContentHash: contentHash(payload) }); }],
  ];
  try {
    // Control: on a verifiable listing the paid completion and the pre-commit failure both count.
    installListedCase(() => {});
    assert.deepEqual(await published(), { verified: true, bundleCount: 1, completionRate: 1 });
    const control = installListedCase(() => {}, failBeforeCommit(0, "negotiate-fixed-price")); asSellerFault();
    assert.equal((await currentGraph(control)).ok, true);
    assert.deepEqual(await published(), { verified: true, bundleCount: 1, completionRate: 0 });
    for (const [name, change, [index, kind], deploy] of cases) await t.test(name, async () => {
      try {
        store.clear(); for (const [key, raw] of original) store.set(key, raw);
        installListedCase(change); deploy?.();
        assert.deepEqual(await published(), excluded, `${name}: completion`);
        process.env.DACS_RAIL_SNAPSHOTS = policy;
        const failure = installListedCase(change, failBeforeCommit(index, kind)); asSellerFault(); deploy?.();
        const graph = await currentGraph(failure);
        assert.equal(graph.ok, false, name);
        assert.match(graph.reason!, /^session verification is indeterminate for every outcome on this listing: /, name);
        assert.deepEqual(await published(), excluded, `${name}: failure`);
      } finally { process.env.DACS_RAIL_SNAPSHOTS = policy; }
    });
    // DACS-3 §8.5.2 check 1: an auction without a reserve names no price, so the agreed currency is
    // open and a pre-commit failure never says whether it would have been DEM. A DEM reserve fixes
    // it, and then the completion and the failure both count.
    const auction = (reservePrice?: Obj) => (s: Obj) => {
      s.pricing = { kind: "auction", selectionRule: "highest-price", ...(reservePrice ? { reservePrice } : {}) };
      (s.pipeline as Obj[])[0] = { kind: "negotiate-sealed-envelope", parameters: { commitDeadline: 1, revealWindow: 60, selectionRule: "highest-price" } };
    };
    const sealedBid = (s: Obj) => { (s.phaseSummary as Obj[])[0].kind = "negotiate-sealed-envelope"; };
    const won = (s: Obj) => { s.derivedFromPattern = "sealed-envelope"; };
    for (const reserve of [{ amount: "1", currency: "DEM" }, undefined]) await t.test(`an auction ${reserve ? "with a DEM reserve" : "without a reserve"}`, async () => {
      store.clear(); for (const [key, raw] of original) store.set(key, raw);
      installListedCase(auction(reserve), sealedBid, won);
      assert.deepEqual(await published(), reserve ? { verified: true, bundleCount: 1, completionRate: 1 } : excluded, "completion");
      const failure = installListedCase(auction(reserve), failBeforeCommit(0, "negotiate-sealed-envelope"), won); asSellerFault();
      if (!reserve) assert.match((await currentGraph(failure)).reason!, /^session verification is indeterminate for every outcome on this listing: /);
      assert.deepEqual(await published(), reserve ? { verified: true, bundleCount: 1, completionRate: 0 } : excluded, "failure");
    });
    // The buyer's read right is the pinned node's (ac8f45f checkReadPermission), which compares address
    // strings exactly: a blacklist entry that only case-folds to the buyer does not stop it reading,
    // so the delivery counts beside the listing's failures instead of being dropped alone.
    await t.test("a delivery the pinned node lets the buyer read counts beside the listing's failures", async () => {
      store.clear(); for (const [key, raw] of original) store.set(key, raw);
      const buyerHex = dids[BUYER].slice(-64);
      assert.notEqual(buyerHex.toUpperCase(), buyerHex);
      installListedCase(() => {});
      const seller = await indexSeller(holders(), [], "demos-native:DEM", { [at(61)]: { acl: { mode: "public", blacklisted: [`0x${buyerHex.toUpperCase()}`] } } });
      assert.deepEqual({ verified: seller.deals[0].refsVerified, bundleCount: seller.reputation.bundleCount, completionRate: seller.reputation.completionRate },
        { verified: true, bundleCount: 1, completionRate: 1 });
      installListedCase(() => {}, failBeforeCommit(0, "negotiate-fixed-price")); asSellerFault();
      assert.deepEqual(await published(), { verified: true, bundleCount: 1, completionRate: 0 });
    });
  } finally {
    process.env.DACS_RAIL_SNAPSHOTS = policy;
    store.clear(); for (const [key, raw] of original) store.set(key, raw);
  }
});

// No Standard or pinned-SDK producer emits this Directory's anchorBindings member, and none is needed: PC-2
// leaves a pay-dem record the one address the signed pipeline's lone pay-dem phase gives it, and the evidence
// signer's own deliverableAnchor names the payload (DACS-4 §9.6.1 step 5). A repeated pay-dem phase gives no
// address, and no member, bound or not, can stand in for one on every outcome, so that listing is neutral.
test("a Standard session without the AnchorBinding extension is verified and counted; a repeated pay-dem phase is neutral", async (t) => {
  const original = new Map(store);
  const withoutBindingProfile = () => {
    for (const [locator, role] of [[at(5), "buyer"], [at(6), "seller"]]) {
      const scope = signedScope(store.get(locator)!, "bundle"); delete scope.anchorBindings;
      store.set(locator, { ...scope, signatures: [BUYER, SELLER].map((signer) => signedWith(scope, "bundle", signer, "party")), anchoredByRole: role });
    }
  };
  const failBeforeCommit = (s: Obj) => {
    delete s.agreementRef; s.settlementEvidence = []; s.ratingRefs = [];
    s.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "fail", errorClass: "permanent" }];
  };
  const asSellerFault = () => {
    for (const [locator, role, outcome] of [[at(5), "buyer", "failed-counterparty"], [at(6), "seller", "failed-perm"]]) {
      const scope = signedScope(store.get(locator)!, "bundle"); scope.outcome = outcome; store.set(locator, copy(role, scope));
    }
  };
  const published = async (nodeRead?: Parameters<typeof indexSeller>[4]) => {
    const seller = await indexSeller(holders(), [], "demos-native:DEM", {}, nodeRead);
    return { verified: seller.deals[0].refsVerified, bundleCount: seller.reputation.bundleCount, completionRate: seller.reputation.completionRate,
      volume: seller.reputation.observedTransactionalVolume, settlement: (seller.deals[0].settlementTxIds ?? []).map((claim) => `${claim.id}@${claim.phaseIndex}`) };
  };
  const SETTLED = `demos:${"ab".repeat(32)}`;
  const excluded = { verified: false, bundleCount: 0, completionRate: null, volume: [], settlement: [] };
  const reset = () => { store.clear(); for (const [key, raw] of original) store.set(key, raw); };
  try {
    await t.test("a lone pay-dem phase: the paid, delivered completion and the failure both count", async () => {
      reset();
      installListedCase(() => {}); withoutBindingProfile();
      assert.equal(store.get(at(5))!.anchorBindings, undefined);
      assert.equal((await currentGraph(store.get(at(1))!)).ok, true);
      assert.deepEqual(await published(), { verified: true, bundleCount: 1, completionRate: 1,
        volume: [{ currency: "DEM", amount: "2" }], settlement: [`${SETTLED}@2`] });
      installListedCase(() => {}, failBeforeCommit); asSellerFault(); withoutBindingProfile();
      assert.deepEqual(await published(), { verified: true, bundleCount: 1, completionRate: 0, volume: [], settlement: [] });
    });
    await t.test("verification still applies without the binding", async () => {
      reset();
      installListedCase(() => {}); withoutBindingProfile();
      // The node does not confirm the transfer.
      assert.deepEqual(await published(async () => null), excluded);
      // The payload at the evidence's deliverableAnchor does not hash to its deliverableContentHash.
      store.set(at(61), { report: "another payload" });
      assert.equal((await currentGraph(store.get(at(1))!)).reason, "storage delivery payload binding failed");
      assert.deepEqual(await published(), excluded);
    });
    await t.test("a repeated pay-dem phase: neutral for every outcome, with or without the binding", async () => {
      reset();
      const repeated = (s: Obj) => { (s.pipeline as Obj[]).splice(3, 0, { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }); };
      // PIPE-5: the second invocation settles the same price in its own transfer.
      const secondScope: Obj = { ...evidenceScope, paymentTxRefs: [{ kind: "demos", blockNumber: 1, txHash: "cd".repeat(32) }], observedAt: 102 };
      const second = { ...secondScope, signature: signedWith(secondScope, "evidence", SELLER) };
      store.set(at(70), second);
      const bothPaid = (s: Obj) => {
        s.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" },
          { index: 2, kind: "pay-dem", outcome: "ok", attestationRef: refTo(at(3), evidence, "evidence") },
          { index: 3, kind: "pay-dem", outcome: "ok", attestationRef: refTo(at(70), second, "evidence") },
          { index: 4, kind: "deliver-storage-program", outcome: "ok" }];
        s.settlementEvidence = [refTo(at(3), evidence, "evidence"), refTo(at(70), second, "evidence"), refTo(at(60), delivery, "evidence")];
      };
      // Its signers' own bindings tell the two payments apart, yet the completion is refused: the pipeline
      // lists no index for either, and the failure below could never show such bindings.
      const listed = installListedCase(repeated, bothPaid);
      assert.equal(store.get(at(5))!.anchorBindings && (store.get(at(5))!.anchorBindings as Obj[]).length, 3);
      assert.equal((await currentGraph(listed)).reason, "payment evidence anchor binding failed");
      assert.deepEqual(await published(), excluded);
      withoutBindingProfile();
      assert.equal((await currentGraph(listed)).reason, "payment evidence anchor binding failed");
      assert.deepEqual(await published(), excluded);
      const neutral = "session verification is indeterminate for every outcome on this listing: " +
        "a repeated pay-dem phase leaves no listed phase index for each payment";
      const failed = installListedCase(repeated, failBeforeCommit); asSellerFault();
      assert.deepEqual(store.get(at(5))!.anchorBindings, []);
      assert.equal((await currentGraph(failed)).reason, neutral);
      assert.deepEqual(await published(), excluded);
      withoutBindingProfile();
      assert.equal((await currentGraph(failed)).reason, neutral);
      assert.deepEqual(await published(), excluded);
    });
  } finally { reset(); }
});

// DACS-5 §10.5.1 for the anchorBindings member. What a bundle has to bind grows with the session: a failure
// before payment has no anchor, so nothing it carries shows whether its completion would have been bound.
// An empty member used to count such a failure while the same listing's paid completion, carrying the same
// member, was refused for want of a binding. The member now never decides admission by outcome: every entry
// is authenticated for every outcome, the listing alone gives each anchor its address, and a listing whose
// pipeline gives none (a repeated pay-dem phase) is neutral whatever the member holds.
test("§10.5.1: an absent, empty, valid, irrelevant or invalid anchorBindings member decides a paid completion and a pre-commit failure alike", async (t) => {
  const original = new Map(store);
  const reset = () => { store.clear(); for (const [key, raw] of original) store.set(key, raw); };
  const failBeforeCommit = (s: Obj) => {
    delete s.agreementRef; s.settlementEvidence = []; s.ratingRefs = [];
    s.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "fail", errorClass: "permanent" }];
  };
  // Both copies re-signed carrying `carried` (undefined omits the member); a failure is the seller's fault.
  const carrying = (carried: Obj[] | undefined, failure: boolean) => {
    for (const [locator, role, outcome] of [[at(5), "buyer", "failed-counterparty"], [at(6), "seller", "failed-perm"]]) {
      const scope = signedScope(store.get(locator)!, "bundle");
      if (failure) scope.outcome = outcome;
      if (carried === undefined) delete scope.anchorBindings; else scope.anchorBindings = carried;
      store.set(locator, { ...scope, signatures: [BUYER, SELLER].map((signer) => signedWith(scope, "bundle", signer, "party")), anchoredByRole: role });
    }
  };
  const published = async () => {
    const seller = await indexSeller(holders());
    return { verified: seller.deals[0].refsVerified, bundleCount: seller.reputation.bundleCount, completionRate: seller.reputation.completionRate };
  };
  const excluded = { verified: false, bundleCount: 0, completionRate: null };
  const repeated = (s: Obj) => { (s.pipeline as Obj[]).splice(3, 0, { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }); };
  const secondScope: Obj = { ...evidenceScope, paymentTxRefs: [{ kind: "demos", blockNumber: 1, txHash: "cd".repeat(32) }], observedAt: 102 };
  const second = { ...secondScope, signature: signedWith(secondScope, "evidence", SELLER) };
  const bothPaid = (s: Obj) => {
    s.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" },
      { index: 2, kind: "pay-dem", outcome: "ok", attestationRef: refTo(at(3), evidence, "evidence") },
      { index: 3, kind: "pay-dem", outcome: "ok", attestationRef: refTo(at(70), second, "evidence") },
      { index: 4, kind: "deliver-storage-program", outcome: "ok" }];
    s.settlementEvidence = [refTo(at(3), evidence, "evidence"), refTo(at(70), second, "evidence"), refTo(at(60), delivery, "evidence")];
  };
  const listings: Array<[string, (s: Obj) => void, (s: Obj) => void, boolean]> = [
    ["a lone pay-dem phase", () => {}, () => {}, true],
    ["a repeated pay-dem phase", repeated, bothPaid, false],
  ];
  try {
    for (const [shape, listed, paid, verifiable] of listings) {
      reset(); store.set(at(70), second);
      installListedCase(listed, paid);
      // The bindings a conforming publisher carries for this completion, each signed by its anchor's own signer.
      const own = anchorBindingsFor(signedScope(store.get(at(5))!, "bundle"));
      assert.equal(own.length, verifiable ? 2 : 3, shape);
      const members: Record<string, Obj[] | undefined> = {
        absent: undefined,
        empty: [],
        valid: own,
        // Signed for this job, but none by its anchor's own signer: the counterparty's and an outsider's.
        irrelevant: own.map((entry, n) => anchorBinding(JOB, String(entry.logicalAddress), String(entry.nativeAddress), String(entry.contentHash), n === 0 ? BUYER : OUTSIDER)),
        // An entry changed after signing; the anchors themselves would still resolve.
        invalid: [...own, { ...own[0], anchorTx: "ab".repeat(32) }],
      };
      for (const [name, carried] of Object.entries(members)) await t.test(`${shape}, ${name} member`, async () => {
        const counted = verifiable && name !== "invalid";
        installListedCase(listed, paid); carrying(carried, false);
        assert.deepEqual(await published(), counted ? { verified: true, bundleCount: 1, completionRate: 1 } : excluded, `${shape}, ${name}: completion`);
        installListedCase(listed, failBeforeCommit); carrying(carried, true);
        assert.deepEqual(await published(), counted ? { verified: true, bundleCount: 1, completionRate: 0 } : excluded, `${shape}, ${name}: failure`);
      });
    }
  } finally { reset(); }
});

test("a committed session is held to its agreed rail and price whatever its outcome", async (t) => {
  // The agreed rail and price are fixed at commitment. Before they were checked only beside a
  // successful payment, so an agreement no payment could settle dropped the completion while an
  // abort after commitment on the same agreement still counted.
  const original = new Map(store);
  const abortAfterCommit = (s: Obj) => {
    s.settlementEvidence = []; s.ratingRefs = [];
    s.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" }];
  };
  const asSellerAbort = () => {
    for (const [locator, role, outcome] of [[at(5), "buyer", "aborted-by-other"], [at(6), "seller", "aborted-by-self"]]) {
      const scope = signedScope(store.get(locator)!, "bundle"); scope.outcome = outcome; store.set(locator, copy(role, scope));
    }
  };
  const published = async () => {
    const seller = await indexSeller(holders());
    return { verified: seller.deals[0].refsVerified, bundleCount: seller.reputation.bundleCount, completionRate: seller.reputation.completionRate };
  };
  try {
    // Control: an abort after commitment on the DEM agreement counts against the seller.
    const control = installListedCase(() => {}, abortAfterCommit); asSellerAbort();
    assert.equal((await currentGraph(control)).ok, true, (await currentGraph(control)).reason);
    assert.deepEqual(await published(), { verified: true, bundleCount: 1, completionRate: 0 });
    // The listing accepts x402 beside DEM, but its only payment phase pays DEM: an agreement on x402
    // can never settle, so the completion and the abort on it are both excluded.
    const x402Agreement = (s: Obj) => { s.acceptedRails = [{ railId: "x402:default" }, { railId: "demos-native:DEM" }]; };
    for (const [name, changeBundle, outcome] of [["completion", () => {}, undefined], ["abort after commitment", abortAfterCommit, asSellerAbort]] as const) {
      await t.test(name, async () => {
        store.clear(); for (const [key, raw] of original) store.set(key, raw);
        const listed = installListedCase(x402Agreement, changeBundle); outcome?.();
        const graph = await currentGraph(listed);
        assert.equal(graph.ok, false);
        assert.equal(graph.reason, "payment phase rail does not match the agreement rail");
        assert.deepEqual(await published(), { verified: false, bundleCount: 0, completionRate: null });
      });
    }
  } finally { store.clear(); for (const [key, raw] of original) store.set(key, raw); }
});

test("a refuted seller cancellation marker cannot hide the buyer copy's established marker", async () => {
  const original = new Map(store);
  try {
    const listed = installListedCase((s) => { s.terms = { cancellationPolicy: "pre-commit" }; }, (s) => {
      delete s.agreementRef; s.settlementEvidence = []; s.ratingRefs = [];
      s.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }];
    });
    for (const [locator, role, outcome, cancellation] of [
      [at(5), "buyer", "aborted-by-self", { claimedPolicy: "pre-commit" }],
      [at(6), "seller", "aborted-by-other", { claimedPolicy: "with-fee" }],
    ] as const) {
      const scope = signedScope(store.get(locator)!, "bundle"); Object.assign(scope, { outcome, cancellation }); store.set(locator, copy(role, scope));
    }
    assert.equal((await currentGraph(listed)).ok, true);
    const seller = await indexSeller(holders());
    assert.equal(seller.deals[0].refsVerified, true); assert.equal(seller.deals[0].cancellationNeutral, true);
    assert.equal(seller.reputation.bundleCount, 1); assert.equal(seller.reputation.completionRate, null);
    assert.equal(seller.reputation.counterpartyFaultRate, null);
  } finally { store.clear(); for (const [key, raw] of original) store.set(key, raw); }
});

test("canonical rail identifiers survive signed listing indexing and rail discovery", async () => {
  const original = new Map(store), prior = loadCatalog();
  const rails = ["demos-native:DEM", "evm-erc20:8453:USDC", "solana-spl:mainnet:USDC"];
  const { saveCatalog } = await import("../src/catalog/store.js");
  const { GET } = await import("../app/api/dacs/listings/route.js");
  const { NextRequest } = await import("next/server");
  try {
    installListedCase((s) => { s.acceptedRails = rails.map((railId) => ({ railId })); });
    const seller = await indexSeller(holders());
    assert.deepEqual(seller.listings[0].offering.rails, rails);
    saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [seller] });
    for (const rail of rails) {
      const response = await GET(new NextRequest(`https://directory.example/api/dacs/listings?rail=${encodeURIComponent(rail)}`));
      const body = await response.json(); assert.equal(body.total, 1); assert.equal(body.listings[0].listingId, "binding-rules");
    }
  } finally { saveCatalog(prior); store.clear(); for (const [key, raw] of original) store.set(key, raw); }
});

test("agreement presence and pre-commit terminal facts cannot contradict one another", async () => {
  const original = new Map(store);
  try {
    for (const [outcome, agreementPresent, phase] of [
      ["failed-perm", true, { index: 1, kind: "commit-agreement", outcome: "fail", errorClass: "permanent" }],
      ["failed-perm", false, { index: 1, kind: "commit-agreement", outcome: "ok" }],
      ["failed-perm", false, { index: 0, kind: "negotiate-fixed-price", outcome: "ok" }],
    ] as const) {
      const listed = installListedCase(() => {}, (s) => {
        s.outcome = outcome; if (!agreementPresent) delete s.agreementRef;
        s.phaseSummary = [phase]; s.settlementEvidence = []; s.ratingRefs = [];
      });
      const graph = await currentGraph(listed); assert.equal(graph.ok, false);
      assert.match(graph.reason!, /failed commitment|has no agreement|no failed terminal phase|terminal phase classification contradicts/);
      await assertUncounted();
    }
  } finally { store.clear(); for (const [key, raw] of original) store.set(key, raw); }
});

// DACS-5 §10.5.1 at run time. The static listing gate decides only what the listing fixes. A paid, delivered
// completion also reads its agreement, evidence, the node and the payload, and can use a delivery choice the
// listing leaves open; a pre-commit failure makes none of those reads. When one of them cannot be decided here
// (no authoritative reply, an external pointer, a payload the anonymous reader is denied), dropping that
// completion alone while the seller's failures still count publishes the seller at 0%. The seller is held
// instead: no session of its counts this pass, whatever its outcome or listing. A record that is false, or
// that a node answer refutes, still excludes only its own session.
const FAILED_JOB = "indexer-binding-failed-job";
const SECOND_LISTING = at(97);
/** A signed pre-commit failure of another job of this seller, on `listed` (stored at `locator`). */
function installFailure(listed: Obj, locator = at(1)) {
  const pinned = { listingId: listed.listingId, version: listed.listingVersion, contentHash: artifactHash(listed, "listing") };
  const scope = bundleScope({ jobId: FAILED_JOB, listingRef: pinned, settlementEvidence: [], ratingRefs: [],
    phaseSummary: [{ index: 0, kind: "negotiate-fixed-price", outcome: "fail", errorClass: "permanent" }] });
  delete scope.agreementRef;
  store.set(locator, listed).set(at(95), copy("buyer", { ...scope, outcome: "failed-counterparty" })).set(at(96), copy("seller", { ...scope, outcome: "failed-perm" }));
}
/** The same listing under another listingId, so a second listing of the seller can carry the failure. */
function secondListing(): Obj {
  const scope = { ...signedScope(store.get(at(1))!, "listing"), listingId: "binding-rules-second" };
  return { ...scope, signature: signedWith(scope, "listing", SELLER) };
}
type NodeReply = (message: string, data: Obj) => Promise<Response>;
/** One pass over both sessions. `node` and `storage` replace the node's reply or one storage read; either may throw. */
async function indexPass(options: { node?: NodeReply; storage?: (locator: string) => Response | undefined } = {}) {
  const nodeRead = nativeNodeFixture(() => store.values());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") {
      const call = JSON.parse(String(init.body)).params?.[0];
      if (["getTxByHash", "getBlockByNumber"].includes(call?.message)) {
        return options.node ? options.node(call.message, call.data) : Response.json({ result: 200, response: await nodeRead(call.message, call.data) });
      }
    }
    const locator = String(input).split("/").pop() ?? "";
    const replaced = options.storage?.(locator);
    if (replaced) return replaced;
    const data = store.get(locator);
    return data ? Response.json({ success: true, owner: `0x${dids[SELLER].slice(-64)}`, acl: { mode: "public" }, programName: OPAQUE_PROGRAM_NAME, data })
      : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
  };
  const failedBinding = (role: "buyer" | "seller", nativeAddress: string, signer: number) =>
    binding(role, nativeAddress, signer, { jobId: FAILED_JOB, logicalAddress: logicalBundleAddress(FAILED_JOB, role) });
  try {
    return await indexRegistration({ primaryClaim: dids[SELLER], displayName: "seller", listingAnchors: [at(1), SECOND_LISTING],
      deals: [
        { jobId: JOB, rail: "demos-native:DEM", buyerBundleRef: at(90), sellerBundleRef: at(91), owners: { buyer: dids[BUYER], seller: dids[SELLER] } },
        { jobId: FAILED_JOB, rail: "demos-native:DEM", buyerBundleRef: at(92), sellerBundleRef: at(93), owners: { buyer: dids[BUYER], seller: dids[SELLER] } },
      ],
      bundleBindings: [...holders(), failedBinding("buyer", at(95), BUYER), failedBinding("seller", at(96), SELLER)] as never },
    undefined, async () => { throw new Error("identity unavailable"); });
  } finally {
    globalThis.fetch = originalFetch;
  }
}
const figures = (seller: Awaited<ReturnType<typeof indexPass>>) => ({ completed: seller.reputation.completed, bundleCount: seller.reputation.bundleCount,
  completionRate: seller.reputation.completionRate, volume: seller.reputation.observedTransactionalVolume,
  held: typeof (seller as { reputationHeld?: unknown }).reputationHeld === "string" });
const BOTH_COUNTED = { completed: 1, bundleCount: 2, completionRate: 0.5, volume: [{ currency: "DEM", amount: "2" }], held: false };
const HELD = { completed: 0, bundleCount: 0, completionRate: null, volume: [], held: true };
const ONLY_FAILURE = { completed: 0, bundleCount: 1, completionRate: 0, volume: [], held: false };
const nodeAnswer = (body: Obj, status = 200) => Response.json(body, { status });
const notFound = (checkedThroughBlock: number) => nodeAnswer({ result: 404, response: null, require_reply: false, extra: { reason: "not_found", checkedThroughBlock } });
/** Replace the payment evidence with `change` applied, re-signed, in both copies of the completion. */
function replacePaymentEvidence(change: (scope: Obj) => void): Obj {
  const scope = signedScope(evidence, "evidence"); change(scope);
  const replaced = { ...scope, signature: signedWith(scope, "evidence", SELLER) };
  store.set(at(3), replaced);
  for (const [locator, role] of [[at(5), "buyer"], [at(6), "seller"]] as const) {
    const bundle = signedScope(store.get(locator)!, "bundle"); delete bundle.anchorBindings;
    bundle.settlementEvidence = [refTo(at(3), replaced, "evidence"), refTo(at(60), delivery, "evidence")];
    store.set(locator, copy(role, bundle));
  }
  return replaced;
}

test("§10.5.1 at run time: a completion this pass cannot decide holds the seller, never drops alone beside its failures", async (t) => {
  const original = new Map(store);
  const reset = () => { store.clear(); for (const [key, raw] of original) store.set(key, raw); };
  try {
    await t.test("control: a verifiable completion and a pre-commit failure both count", async () => {
      reset(); installFailure(installListedCase(() => {}));
      assert.deepEqual(figures(await indexPass()), BOTH_COUNTED);
      // The failure on the seller's second listing counts the same way.
      reset(); installListedCase(() => {}); installFailure(secondListing(), SECOND_LISTING);
      assert.deepEqual(figures(await indexPass()), BOTH_COUNTED);
    });
    // Daybreak P1-2: a node outage, an error reply, a reply without the transaction and a node that has not
    // reached the cited block are no answer about the transfer.
    for (const [name, node] of [
      ["the node is unreachable", async () => { throw new TypeError("fetch failed"); }],
      ["the node answers HTTP 500", async () => new Response("upstream error", { status: 500 })],
      ["the node answers result 500", async () => nodeAnswer({ result: 500, response: "internal error" })],
      ["the node answers result 200 without a transaction", async () => nodeAnswer({ result: 200, response: null })],
      ["the node has not reached the cited block", async () => notFound(0)],
      ["the node answers an unstructured 404", async () => nodeAnswer({ result: 404, response: null })],
      ["the node answers the pinned source's 400", async () => nodeAnswer({ result: 400, response: "error" })],
    ] as Array<[string, NodeReply]>) {
      await t.test(`${name}: the seller is held`, async () => {
        reset(); installFailure(installListedCase(() => {}));
        assert.deepEqual(figures(await indexPass({ node })), HELD);
        reset(); installListedCase(() => {}); installFailure(secondListing(), SECOND_LISTING);
        assert.deepEqual(figures(await indexPass({ node })), HELD, "failure on another listing");
      });
    }
    await t.test("a node that checked past the cited block and has no such transfer refutes that completion only", async () => {
      reset(); installFailure(installListedCase(() => {}));
      const seller = await indexPass({ node: async (message) => message === "getTxByHash" ? notFound(3901) : nodeAnswer({ result: 200, response: null }) });
      assert.deepEqual(figures(seller), ONLY_FAILURE);
      assert.equal(seller.deals.find((deal) => deal.jobId === JOB)?.refsVerified, false);
    });
    // Daybreak P1-1: delivery choices the listing leaves open.
    await t.test("an extended-pointer payload (§9.6.1) holds the seller", async () => {
      reset(); installFailure(installListedCase(() => {}));
      store.set(at(61), { externalUrl: "https://payload.example/report", externalContentHash: contentHash(payload) });
      assert.deepEqual(figures(await indexPass()), HELD);
    });
    await t.test("a public listing delivered privately (DV-2 over-provision) holds the seller", async () => {
      reset(); installFailure(installListedCase(() => {}));
      const denied = () => Response.json({ success: false, errorCode: "PERMISSION_DENIED" }, { status: 403 });
      assert.deepEqual(figures(await indexPass({ storage: (locator) => locator === at(61) ? denied() : undefined })), HELD);
    });
    await t.test("a held seller stays held through the catalog-wide save, and the seller API says why", async () => {
      reset(); installFailure(installListedCase(() => {}));
      const held = await indexPass({ node: async () => { throw new TypeError("fetch failed"); } });
      const { saveCatalog } = await import("../src/catalog/store.js");
      const route = await import("../app/api/dacs/sellers/[primaryClaimRef]/route.js");
      const { NextRequest } = await import("next/server");
      const prior = loadCatalog();
      try {
        saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [held] });
        const saved = loadCatalog().sellers[0];
        assert.equal(saved.reputation.completionRate, null); assert.equal(saved.reputation.bundleCount, 0);
        assert.match(saved.reputationHeld!, /^indexer-binding-job: native payment verification is indeterminate: the node's getTxByHash reply failed \(transport\)$/);
        const response = await route.GET(new NextRequest(`https://directory.example/api/dacs/sellers/${encodeURIComponent(dids[SELLER])}`),
          { params: Promise.resolve({ primaryClaimRef: encodeURIComponent(dids[SELLER]) }) });
        const body = await response.json();
        assert.equal(body.reputation.held, saved.reputationHeld); assert.equal(body.reputation.completionRate, null);
      } finally { saveCatalog(prior); }
    });
    // The same pattern on the other reads only a committed session makes.
    for (const [name, locator] of [["agreement", at(2)], ["payment evidence", at(3)], ["delivery evidence", at(60)], ["payload", at(61)]] as const) {
      await t.test(`the ${name} read has no answer: the seller is held`, async () => {
        reset(); installFailure(installListedCase(() => {}));
        assert.deepEqual(figures(await indexPass({ storage: (read) => { if (read === locator) throw new TypeError("fetch failed"); return undefined; } })), HELD);
        reset(); installFailure(installListedCase(() => {}));
        assert.deepEqual(figures(await indexPass({ storage: (read) => read === locator ? new Response("bad gateway", { status: 502 }) : undefined })), HELD);
      });
    }
  } finally { reset(); }
});

test("§10.5.1 at run time: an answer refutes one session, and only a session the seller signed can hold it", async (t) => {
  const original = new Map(store);
  const reset = () => { store.clear(); for (const [key, raw] of original) store.set(key, raw); };
  const denied = () => Response.json({ success: false, errorCode: "PERMISSION_DENIED" }, { status: 403 });
  const oversized = () => Response.json({ success: true, owner: `0x${dids[SELLER].slice(-64)}`, acl: { mode: "public" }, programName: OPAQUE_PROGRAM_NAME,
    data: { padding: "x".repeat(256 * 1024) } });
  const unanswered = (locator: string) => (read: string) => { if (read === locator) throw new TypeError("fetch failed"); return undefined; };
  try {
    // Closing or bloating a record is an answer its owner gives, like deleting it: it refutes only the session that
    // cites it. A counterparty that owns such a record therefore cannot hold the seller with it.
    for (const [name, locator] of [["agreement", at(2)], ["payment evidence", at(3)], ["delivery evidence", at(60)]] as const) {
      for (const [how, reply] of [["denied", denied], ["oversized", oversized]] as const) {
        await t.test(`${how === "oversized" ? "an" : "a"} ${how} ${name} refutes that completion only`, async () => {
          reset(); installFailure(installListedCase(() => {}));
          assert.deepEqual(figures(await indexPass({ storage: (read) => read === locator ? reply() : undefined })), ONLY_FAILURE);
        });
      }
    }
    // A pre-commit abort whose copies are each signed by their anchor alone, beside the paid completion. A rating
    // that copy cites cannot be read this pass.
    const abortCopies = (ratingOn: "buyer" | "seller") => {
      const scope = bundleScope({ jobId: FAILED_JOB, settlementEvidence: [], ratingRefs: [],
        phaseSummary: [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }] });
      delete scope.agreementRef;
      const rated = { ...scope, ratingRefs: [{ anchor: { kind: "storage-program", locator: at(98) }, contentHash: "c".repeat(64) }] };
      store.set(at(95), copy("buyer", { ...(ratingOn === "buyer" ? rated : scope), outcome: "aborted-by-other" }, [BUYER]))
        .set(at(96), copy("seller", { ...(ratingOn === "seller" ? rated : scope), outcome: "aborted-by-self" }, [SELLER]));
    };
    await t.test("an undecided copy only the buyer signed leaves that session uncounted and the seller counted", async () => {
      reset(); installListedCase(() => {}); abortCopies("buyer");
      // That copy is held, and its only verified signature is the buyer's.
      const buyerCopy = await buildCurrentEvidenceGraph(at(95), { resolveListing: async () => ({ locator: at(1), raw: store.get(at(1))! }),
        read: async (locator) => { if (locator === at(98)) throw new VerificationUnavailable("no answer"); return store.get(locator) ?? null; } });
      assert.equal(buyerCopy.held, "session verification is undecided this pass: no answer");
      assert.deepEqual(buyerCopy.signedParties, [dids[BUYER]]);
      const seller = await indexPass({ storage: unanswered(at(98)) });
      assert.deepEqual(figures(seller), { completed: 1, bundleCount: 1, completionRate: 1, volume: [{ currency: "DEM", amount: "2" }], held: false });
      assert.equal(seller.deals.find((deal) => deal.jobId === FAILED_JOB)?.refsVerified, false);
    });
    await t.test("the same unanswered read in the seller's own copy holds the seller", async () => {
      reset(); installListedCase(() => {}); abortCopies("seller");
      assert.deepEqual(figures(await indexPass({ storage: unanswered(at(98)) })), HELD);
    });
    await t.test("a bundle that cannot be read is no one's session yet: it is not held", async () => {
      reset(); installListedCase(() => {});
      const graph = await buildCurrentEvidenceGraph(at(5), { read: async () => { throw new VerificationUnavailable("the storage read had no answer (transport)"); },
        resolveListing: async () => ({ locator: at(1), raw: store.get(at(1))! }) });
      assert.equal(graph.ok, false); assert.equal(graph.held, undefined); assert.equal(graph.signaturesVerified, false);
      assert.equal(graph.reason, "session verification is undecided this pass: the storage read had no answer (transport)");
    });
  } finally { reset(); }
});

test("cold review P1: an evidence attestationRef is hash-bound and decides no outcome under the production adapters", async (t) => {
  const original = new Map(store);
  const reset = () => { store.clear(); for (const [key, raw] of original) store.set(key, raw); };
  const attestation = { attestationVersion: "1", note: "payment observed by an external service" };
  const attested = (hash = artifactHash(attestation, "attestation")) => replacePaymentEvidence((scope) => {
    scope.attestationRef = { anchor: { kind: "storage-program", locator: at(80) }, contentHash: hash };
  });
  try {
    await t.test("the paid completion counts beside the seller's failure", async () => {
      reset(); const listed = installListedCase(() => {}); store.set(at(80), attestation); attested();
      // Production installs no verifyAttestation adapter.
      assert.equal((await currentGraph(listed)).ok, true, (await currentGraph(listed)).reason);
      installFailure(listed);
      assert.deepEqual(figures(await indexPass()), BOTH_COUNTED);
    });
    await t.test("a record that does not hash to the reference refutes that completion only", async () => {
      reset(); const listed = installListedCase(() => {}); store.set(at(80), { ...attestation, note: "rewritten" }); attested();
      assert.equal((await currentGraph(listed)).reason, "delivery attestation reference failed");
      installFailure(listed);
      assert.deepEqual(figures(await indexPass()), ONLY_FAILURE);
    });
  } finally { reset(); }
});
