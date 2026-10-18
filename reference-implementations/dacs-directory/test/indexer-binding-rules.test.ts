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
const copy = (anchoredByRole: string, scope = bundleScope(), signers = [BUYER, SELLER]) => {
  const bindings = scope.anchorBindings === undefined ? anchorBindingsFor(scope) : [];
  const carried = bindings.length > 0 ? { ...scope, anchorBindings: bindings } : scope;
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
  assert.deepEqual(deal.settlementTxIds, [{ id: `demos:${"ab".repeat(32)}`, observedAt: 100, phaseIndex: 2, evidenceHash: artifactHash(evidence, "evidence") }]);
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

test("a completed deal with no pay phase or evidence never contributes reputation (review probe P4)", async () => {
  const bare = bundleScope({ phaseSummary: [], settlementEvidence: [] });
  store.set(at(20), copy("buyer", bare)).set(at(21), copy("seller", bare));
  const deal = await index([binding("buyer", at(20), BUYER), binding("seller", at(21), SELLER)]);
  assert.equal(deal.refsVerified, false);
  assert.equal(deal.reputationEligible, false);
});

test("completed sessions reject failed mandatory phases and retain the non-fatal rate exception", async () => {
  const original = new Map(store);
  try {
    for (const kind of ["pay-dem", "deliver-storage-program", "deliver-entitlement", "deliver-attested-payload", "vet-credentials", "negotiate-fixed-price", "commit-agreement", "rate"]) {
      store.clear(); for (const [key, raw] of original) store.set(key, raw);
      const failedSettlement = kind.startsWith("pay-") || kind.startsWith("deliver-");
      const pipeline = structuredClone(listingScope.pipeline) as Obj[];
      if (kind !== "pay-dem") pipeline.push({ kind });
      const listedScope = { ...listingScope, pipeline };
      const listed = { ...listedScope, signature: signedWith(listedScope, "listing", SELLER) };
      store.set(at(1), listed);
      const listingRef = { ...bundleScope().listingRef as Obj, contentHash: artifactHash(listed, "listing") };
      const agreedScope = { ...agreementScope, listingRef };
      const agreed = { ...agreedScope, signatures: [signedWith(agreedScope, "agreement", BUYER, "party"), signedWith(agreedScope, "agreement", SELLER, "party")] };
      store.set(at(2), agreed);
      const failedScope: Obj = { evidenceVersion: "1", jobId: JOB, phase: kind, outcome: "failure", observedAt: 100 };
      const failed = { ...failedScope, signature: signedWith(failedScope, "evidence", SELLER) };
      store.set(at(30), failed);
      const phaseSummary = kind === "pay-dem" ? [{ index: 2, kind, outcome: "fail", errorClass: "permanent" }]
        : [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" }, { index: 2, kind: "pay-dem", outcome: "ok" }, { index: 3, kind, outcome: "fail", errorClass: "permanent" }];
      const settlementEvidence = kind === "pay-dem" ? [refTo(at(30), failed, "evidence")]
        : [refTo(at(3), evidence, "evidence"), ...(failedSettlement ? [refTo(at(30), failed, "evidence")] : [])];
      if (kind === "rate") { phaseSummary[3].index = 4; phaseSummary.splice(3, 0, { index: 3, kind: "deliver-storage-program", outcome: "ok" } as never); settlementEvidence.push(refTo(at(60), delivery, "evidence")); }
      const scope = bundleScope({ listingRef, agreementRef: refTo(at(2), agreed, "agreement"), phaseSummary, settlementEvidence });
      store.set(at(20), copy("buyer", scope)).set(at(21), copy("seller", scope));
      const graph = await buildCurrentEvidenceGraph(at(20), {
        readSettlementNode: nativeNodeFixture(() => store.values()),
        read: async (locator) => store.get(locator) ?? null,
        readAnchorRecord: async (locator) => ({ data: store.get(locator)!, acl: { mode: "public" }, programName: OPAQUE_PROGRAM_NAME }),
        resolveListing: async () => ({ locator: at(1), raw: listed }),
      });
      assert.equal(graph.signaturesVerified, true, kind);
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

test("each signed payment phase requires its own transaction kind and complete ChainTxRef fields", async (t) => {
  const hash = "ab".repeat(32);
  const rails: Array<{ phase: string; ref: Obj; finality: Obj; required: string[] }> = [
    { phase: "pay-dem", ref: { kind: "demos", blockNumber: 1, txHash: hash }, finality: { model: "bft-final" }, required: ["txHash", "blockNumber"] },
    { phase: "pay-evm-erc20", ref: { kind: "evm", chainId: 8453, txHash: hash, logIndex: 0 }, finality: { model: "block-depth", finalityBlocks: 1 }, required: ["chainId", "txHash"] },
    { phase: "pay-solana-spl", ref: { kind: "solana", cluster: "devnet", signature: "1".repeat(64), instructionIndex: 0 }, finality: { model: "commitment-level", finalityCommitmentLevel: "finalized" }, required: ["cluster", "signature"] },
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
    policy?: Obj[]; wrongLocator?: boolean; hashPrefix?: string; rawPolicy?: string; callback?: boolean; primaryProof?: boolean; badAuthority?: boolean; malformedFreshness?: boolean; identityRef?: boolean; generatedAt?: number; verifiedByVersion?: number; sellerFromListing?: boolean; badAnchorHash?: boolean; bundleOutcome?: string; graphOnly?: boolean };
  const requirement = { requirementVersion: "1", required: [{ scheme: "lei", verificationRequired: true, recipeVersion: 1 }] };
  const livePolicy = { scheme: "lei", recipeVersion: 1, defaultMaxAgeSec: 1, methods: ["verifiable-credential"], availability: "live", trustedResultSigners: [dids[OUTSIDER]] };
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
    { name: "verified selected primary with independent required claim", primaryProof: true, requirement: { ...requirement, primaryClaimSelector: "did" }, expected: true },
    { name: "only oneOf still requires vet pipeline", noVet: true, requirement: { requirementVersion: "1", required: [], oneOf: [[{ scheme: "lei", verificationRequired: true }]] } },
    { name: "only oneOf still requires vet execution", omittedVet: true, requirement: { requirementVersion: "1", required: [], oneOf: [[{ scheme: "lei", verificationRequired: true }]] } },
    { name: "only selector still requires vet pipeline", noVet: true, primaryProof: true, requirement: { requirementVersion: "1", required: [], primaryClaimSelector: "did" } },
    { name: "only selector still requires vet execution", omittedVet: true, primaryProof: true, requirement: { requirementVersion: "1", required: [], primaryClaimSelector: "did" } },
    { name: "only oneOf successful proof", requirement: { requirementVersion: "1", required: [], oneOf: [[{ scheme: "lei", verificationRequired: true }]] }, expected: true },
    { name: "only selector successful proof", primaryProof: true, requirement: { requirementVersion: "1", required: [], primaryClaimSelector: "did" }, expected: true },
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
    { name: "selector requires the exact presentedBy verification", requirement: { ...requirement, primaryClaimSelector: "did" } },
    { name: "oneOf alternative must occur in presented claims", noClaim: true, requirement: { requirementVersion: "1", required: [], oneOf: [[{ scheme: "lei", verificationRequired: true }]] } },
    { name: "freshness is mandatory even without verificationRequired", result: { validUntil: 29 }, requirement: { ...requirement, required: [{ scheme: "lei", verificationRequired: false }] } },
    { name: "issuedAt cannot widen listing maxAge", claim: { issuedAt: 2020 }, requirement: { ...requirement, required: [{ scheme: "lei", verificationRequired: true, maxAge: 1 }] }, generatedAt: 2020, result: { validUntil: 10000 } },
  ];
  const presented = (party: number, scope: Obj) => ({ ...scope, presentation: { kind: "per-claim", signatures: [{ ref: dids[party],
    signature: Buffer.from(ed25519Sign(Buffer.from(`dacs-bundle-presentation:v1:${contentHash(scope)}`), privateKeyFromSeed(seeds[party]))).toString("hex") }] } });
  try {
    for (const c of cases) await t.test(c.name, async () => {
      store.clear(); for (const [key, raw] of original) store.set(key, raw);
      process.env.DACS_RECIPE_POLICIES = c.rawPolicy ?? JSON.stringify([...(c.policy ?? [{}]).map((policy) => ({ ...livePolicy, ...policy })), ...(c.primaryProof ? [{ ...livePolicy, scheme: "did" }] : [])]);
      try { process.env.DACS_RECIPE_SNAPSHOTS = JSON.stringify([{ registryVersion: 1, recipes: c.snapshotPolicies ? c.snapshotPolicies.map((policy) => ({ ...livePolicy, ...policy })) : JSON.parse(process.env.DACS_RECIPE_POLICIES!) }]); } catch { process.env.DACS_RECIPE_SNAPSHOTS = "[]"; }
      const req = c.requirement ?? requirement;
      const pipeline = [...(c.noVet ? [] : [{ kind: "vet-credentials" }]), { kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }, { kind: "deliver-storage-program" }];
      const listedScope = { ...listingScope, buyerRequirement: req, pipeline };
      const listed = { ...listedScope, signature: signedWith(listedScope, "listing", SELLER) };
      const pinned = { ...listingRef, contentHash: artifactHash(listed, "listing") };
      const agreedScope = { ...agreementScope, listingRef: pinned };
      const agreed = { ...agreedScope, signatures: [signedWith(agreedScope, "agreement", BUYER, "party"), signedWith(agreedScope, "agreement", SELLER, "party")] };
      const attestation = authorityProof({ authority: "registry", decision: "pass" }, 7, c.snapshotControl ? "proofSignature" : "signature");
      const resultScope: Obj = { resultVersion: "1", scheme: "lei", identifier: "5493001KJTIIGC8Y1R12", recipeVersion: 1,
        method: "verifiable-credential", decision: "pass", reason: "registry match", fetchedAt: 10, verifiedAt: 20, validUntil: 100,
        attestation: { anchor: { kind: "storage-program", locator: at(80) }, contentHash: proofHash(attestation), signer: authoritySigner }, ...c.result };
      for (const key of Object.keys(resultScope)) if (resultScope[key] === undefined) delete resultScope[key];
      const result = { ...resultScope, signature: signedWith(resultScope, "verify-result", OUTSIDER) };
      const resultRef = { ...refTo(at(81), result, "verify-result"), recipeVersion: 1 };
      const claim: Obj = { ref: "lei:5493001KJTIIGC8Y1R12", verifiedBy: { ...resultRef, recipeVersion: c.verifiedByVersion ?? 1 }, ...c.claim };
      for (const key of Object.keys(claim)) if (claim[key] === undefined) delete claim[key];
      if (c.wrongLocator) (claim.verifiedBy as Obj).anchor = { kind: "storage-program", locator: at(82) };
      if (c.hashPrefix) (claim.verifiedBy as Obj).contentHash = c.hashPrefix + String(resultRef.contentHash).toUpperCase();
      const primaryScope: Obj = { ...resultScope, scheme: "did", identifier: dids[BUYER].slice(4) };
      const primaryResult = { ...primaryScope, signature: signedWith(primaryScope, "verify-result", OUTSIDER) };
      const primaryRef = { ...refTo(at(85), primaryResult, "verify-result"), recipeVersion: 1 };
      store.set(at(85), primaryResult);
      const buyerScope: Obj = { bundleVersion: "1", presentedBy: dids[BUYER], presentedAt: 1, sessionNonce: `challenge-${dids[BUYER]}`,
        claims: [{ ref: dids[BUYER], ...(c.primaryProof ? { verifiedBy: primaryRef } : {}) }, ...(c.noClaim ? [] : [claim])], ...c.buyer };
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
          freshness: party === BUYER ? [resultRef, ...(c.primaryProof ? [primaryRef] : [])] : (c.malformedFreshness ? [{ contentHash: "0".repeat(64) }] : []), dealSpecific: [], supplementary: [], overallDecision: "pass", generatedAt: c.generatedAt ?? 30 } as Obj;
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
      const phaseSummary = pipeline.flatMap((phase, index) => c.omittedVet && index === 0 ? [] :
        [{ index, kind: phase.kind, outcome: "ok", ...(index === 0 && pointer ? { attestationRef: pointer } : {}) }]);
      const scope = bundleScope({ recipeRegistryVersion: c.registryVersion ?? 1, listingRef: pinned, agreementRef: refTo(at(2), agreed, "agreement"), parties, outcome: c.bundleOutcome ?? "completed", vetRecords: refs, phaseSummary, finalisedAt: Math.max(120, c.generatedAt ?? 30) });
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
        readSettlementNode: nativeNodeFixture(() => store.values()),
        read: async (locator) => store.get(locator) ?? null,
        readAnchorRecord: async (locator) => ({ data: store.get(locator)!, acl: { mode: "public" }, programName: OPAQUE_PROGRAM_NAME }),
        resolveListing: async () => ({ locator: at(1), raw: listed }),
      });
      if (c.snapshotControl) {
        const selectedSnapshot = process.env.DACS_RECIPE_SNAPSHOTS;
        process.env.DACS_RECIPE_SNAPSHOTS = JSON.stringify([{ registryVersion: 1, recipes: [livePolicy] }]);
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
      if (c.firstAttempt || ["scope-only", "legacy-marker", "missing-digest"].includes(c.challenge ?? "")) {
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
    { name: "verified buyer-only payload", accessModel: "buyer-only", metadata: { acl: { mode: "restricted", allowed: [`0x${dids[BUYER].slice(-64)}`] } }, expected: true },
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
function installListedCase(change: (scope: Obj) => void, changeBundle: (scope: Obj) => void = () => {}) {
  const listedScope = structuredClone(listingScope); change(listedScope);
  const listed = { ...listedScope, signature: signedWith(listedScope, "listing", SELLER) };
  const pinned = { ...listingRef, contentHash: artifactHash(listed, "listing") };
  const agreedScope = { ...agreementScope, listingRef: pinned, terms: { ...agreementScope.terms as Obj,
    rail: (listedScope.acceptedRails as Obj[])[0],
    deliverable: { deliverableType: (listedScope.offering as Obj).deliverable && ((listedScope.offering as Obj).deliverable as Obj).kind,
      hash: contentHash((listedScope.offering as Obj).deliverable as Obj) } } };
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
    for (const change of [
      (scope: Obj) => { scope.pipeline = (scope.pipeline as Obj[]).slice(0, 3); },
      (scope: Obj) => { (scope.pipeline as Obj[]).push({ kind: "vet-credentials" }); },
      (scope: Obj) => { ((scope.seller as Obj).identity as Obj).bundleVersion = "2"; },
      (scope: Obj) => { (scope.pipeline as Obj[])[0].parameters = {}; },
      (scope: Obj) => { (scope.pipeline as Obj[])[1].parameters = { unexpected: true }; },
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
    for (const phaseRail of ["demos-native:DEM", "x402:default"]) {
      const listed = installListedCase((scope) => {
        scope.acceptedRails = [{ railId: "demos-native:DEM" }, { railId: "x402:default" }];
        (scope.pipeline as Obj[])[2].parameters = { rail: phaseRail };
      });
      const graph = await currentGraph(listed);
      const expected = phaseRail === "demos-native:DEM";
      assert.equal(graph.ok, expected, graph.reason);
      if (!expected) assert.equal(graph.reason, "payment phase rail does not match the agreement rail");
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
    for (const kind of ["vet-credentials", "negotiate-fixed-price", "commit-agreement"]) {
      const listed = installListedCase((s) => { if (kind === "vet-credentials") (s.pipeline as Obj[]).unshift({ kind }); }, (s) => {
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
      assert.match(graph.reason!, /failed commitment|has no agreement|no failed terminal phase/);
      await assertUncounted();
    }
  } finally { store.clear(); for (const [key, raw] of original) store.set(key, raw); }
});
