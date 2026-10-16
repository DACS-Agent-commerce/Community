import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";

// The indexer resolves each side of a current-profile deal only through BundleBindings its own
// role holder signed (DACS-5 BB-5..BB-7), and reports the deal unverified otherwise.
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-indexer-binding-rules-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
const { indexRegistration } = await import("../src/catalog/indexer.js");
const { artifactHash, buildCurrentEvidenceGraph, paymentTxRefsOk, signedScope } = await import("../src/catalog/evidenceGraph.js");
const { bundleBindingOverflowKey, logicalBundleAddress } = await import("../src/catalog/bundleBinding.js");
const { loadScanState, saveScanState, loadCatalog } = await import("../src/catalog/store.js");
const { fullSignatureStanding } = await import("../src/catalog/bundleSignerPolicy.js");
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
  offering: { title: "rules", description: "rules", category: "rules.binding", tags: [], deliverable: { kind: "attested-payload", payloadFormat: "application/json" } },
  buyerRequirement: { requirementVersion: "1", required: [] },
  pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "pay-dem", parameters: { rail: "pay-dem" } }],
  pricing: { kind: "fixed", price: { amount: "2", currency: "DEM" } }, acceptedRails: [{ railId: "pay-dem" }], terms: {}, validity: { notBefore: 1 },
};
const listing = { ...listingScope, signature: signedWith(listingScope, "listing", SELLER) };
const listingRef = { listingId: "binding-rules", version: 1, contentHash: artifactHash(listing, "listing") };
const agreementScope: Obj = { agreementVersion: "1", jobId: JOB, listingRef, derivedFromPattern: "fixed-price",
  parties: [{ role: "buyer", primaryClaim: dids[BUYER] }, { role: "seller", primaryClaim: dids[SELLER] }],
  terms: { price: { amount: "2", currency: "DEM" }, rail: { railId: "pay-dem" }, deliverable: { deliverableType: "attested-payload", hash: contentHash({ kind: "attested-payload", payloadFormat: "application/json" }) } } };
const agreement = { ...agreementScope, signatures: [signedWith(agreementScope, "agreement", BUYER, "party"), signedWith(agreementScope, "agreement", SELLER, "party")] };
const evidenceScope: Obj = { evidenceVersion: "1", jobId: JOB, phase: "pay-dem", outcome: "success", paymentTxRefs: [{ kind: "demos", txHash: `0x${"AB".repeat(32)}` }],
  paymentAmount: { amount: "2", currency: "DEM" }, settlementFinality: { model: "bft-final", finalityObservedAt: 100 }, observedAt: 100 };
const evidence = { ...evidenceScope, signature: signedWith(evidenceScope, "evidence", SELLER) };
const ratingScope: Obj = { ratingVersion: "1", jobId: JOB, rater: dids[BUYER], target: dids[SELLER], targetRole: "seller", value: 4, ratedAt: 110 };
const rating = { ...ratingScope, signature: signedWith(ratingScope, "rating", BUYER) };
store.set(at(1), listing).set(at(2), agreement).set(at(3), evidence).set(at(4), rating);
const bundleScope = (change: Obj = {}): Obj => ({
  bundleVersion: "1", jobId: JOB, outcome: "completed", listingRef, agreementRef: refTo(at(2), agreement, "agreement"),
  parties: [{ role: "buyer", bundleHash: "a".repeat(64), primaryClaim: dids[BUYER] }, { role: "seller", bundleHash: "b".repeat(64), primaryClaim: dids[SELLER] }],
  phaseSummary: [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" }, { index: 2, kind: "pay-dem", outcome: "ok" }], vetRecords: [], settlementEvidence: [refTo(at(3), evidence, "evidence")],
  ratingRefs: [refTo(at(4), rating, "rating")], recipeRegistryVersion: 1, railRegistryVersion: 1, finalisedAt: 120, ...change,
});
const copy = (anchoredByRole: string, scope = bundleScope(), signers = [BUYER, SELLER]) =>
  ({ ...scope, signatures: signers.map((signer) => signedWith(scope, "bundle", signer, "party")), anchoredByRole });
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

async function indexSeller(bindings: Obj[], overflow: string[] = [], rail = "pay-dem", phaseIndex = 2) {
  const state = loadScanState();
  state.bundleBindingOverflow = overflow;
  saveScanState(state);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const data = store.get(String(input).split("/").pop() ?? "");
    return data ? Response.json({ success: true, owner: `0x${dids[SELLER].slice(-64)}`, programName: `dacs4:payment:${data.jobId}:${data.phase ?? "pay-dem"}:${phaseIndex}`, data }) : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
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
  assert.equal(deal.rail, "pay-dem");
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
  const aborted = (outcome: string) => { const scope = bundleScope({ outcome }); delete scope.agreementRef; return scope; };
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
  const aborted = (outcome: string) => { const scope = bundleScope({ outcome }); delete scope.agreementRef; return scope; };
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
      const scope = bundleScope({ listingRef, agreementRef: refTo(at(2), agreed, "agreement"), phaseSummary, settlementEvidence });
      store.set(at(20), copy("buyer", scope)).set(at(21), copy("seller", scope));
      const graph = await buildCurrentEvidenceGraph(at(20), {
        read: async (locator) => store.get(locator) ?? null,
        readAnchorRecord: async (locator) => ({ data: store.get(locator)!, programName: `dacs4:payment:${JOB}:pay-dem:2` }),
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
    { phase: "pay-dem", ref: { kind: "demos", txHash: hash }, finality: { model: "bft-final" }, required: ["txHash"] },
    { phase: "pay-evm-erc20", ref: { kind: "evm", chainId: 8453, txHash: hash, logIndex: 0 }, finality: { model: "block-depth", finalityBlocks: 1 }, required: ["chainId", "txHash"] },
    { phase: "pay-solana-spl", ref: { kind: "solana", cluster: "devnet", signature: "1".repeat(64), instructionIndex: 0 }, finality: { model: "commitment-level", finalityCommitmentLevel: "finalized" }, required: ["cluster", "signature"] },
    { phase: "pay-x402", ref: { kind: "x402", httpResource: "https://example.com/resource", paymentReceiptHash: hash, protocolVersion: "2", settlementTxHash: hash, chainId: 8453, logIndex: 0 }, finality: { model: "block-depth", finalityBlocks: 1 }, required: ["httpResource", "paymentReceiptHash", "protocolVersion", "chainId"] },
    { phase: "pay-ap2", ref: { kind: "ap2", mandateId: "mandate", providerRef: "receipt", protocolVersion: "1", receiptAttestation: { anchor: { kind: "storage-program", locator: at(60) }, contentHash: contentHash({ receipt: true }) } }, finality: { model: "provider-receipt" }, required: ["mandateId", "providerRef", "protocolVersion", "receiptAttestation"] },
    { phase: "pay-cross-chain-htlc", ref: { kind: "htlc-claim", chainId: 8453, contractAddress: `0x${"12".repeat(20)}`, claimTxHash: hash }, finality: { model: "htlc-reveal" }, required: ["chainId", "contractAddress", "claimTxHash"] },
    { phase: "pay-cross-chain-liquidity-tank", ref: { kind: "liquidity-tank", bridgeId: "bridge", sourceChainId: 1, destChainId: 2, lockTxHash: hash, releaseTxHash: hash }, finality: { model: "liquidity-tank" }, required: ["bridgeId", "sourceChainId", "destChainId", "lockTxHash", "releaseTxHash"] },
  ];
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
      if (rail.phase === "pay-x402") {
        const receiptOnly = { ...rail.ref }; delete receiptOnly.settlementTxHash; delete receiptOnly.chainId;
        variants.push(["provider receipt", [receiptOnly], true]);
        variants.push(["uppercase receipt hash", [{ ...rail.ref, paymentReceiptHash: hash.toUpperCase() }], false]);
        variants.push(["prefixed receipt hash", [{ ...rail.ref, paymentReceiptHash: `0x${hash}` }], false]);
        for (const version of ["0", "3", "12", "999", "02", ["2"], 2])
          variants.push([`unsupported protocol ${JSON.stringify(version)}`, [{ ...rail.ref, protocolVersion: version }], false]);
        variants.push(["version 1", [{ ...rail.ref, protocolVersion: "1" }], true]);
        variants.push(["orphan chainId", [Object.fromEntries(Object.entries(rail.ref).filter(([key]) => key !== "settlementTxHash"))], false]);
      }
      for (const [name, refs, expected] of variants) {
        await t.test(`${rail.phase}: ${name}`, async () => {
        store.clear(); for (const [key, raw] of original) store.set(key, raw);
        store.set(at(60), { receipt: true });
        const listedScope = { ...listingScope, pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: rail.phase, parameters: { rail: rail.phase } }], acceptedRails: [{ railId: rail.phase }] };
        const listed = { ...listedScope, signature: signedWith(listedScope, "listing", SELLER) };
        store.set(at(1), listed);
        const listingRef = { listingId: "binding-rules", version: 1, contentHash: artifactHash(listed, "listing") };
        const agreedScope = { ...agreementScope, listingRef, terms: { ...agreementScope.terms as Obj, rail: { railId: rail.phase } } };
        const agreed = { ...agreedScope, signatures: [signedWith(agreedScope, "agreement", BUYER, "party"), signedWith(agreedScope, "agreement", SELLER, "party")] };
        store.set(at(2), agreed);
        const paidScope = { ...evidenceScope, phase: rail.phase, paymentTxRefs: refs, settlementFinality: { ...rail.finality, ...(name === "provider receipt" ? { model: "provider-receipt" } : {}), finalityObservedAt: 100 } };
        const paid = { ...paidScope, signature: signedWith(paidScope, "evidence", SELLER) };
        store.set(at(3), paid);
        const scope = bundleScope({ listingRef, agreementRef: refTo(at(2), agreed, "agreement"), phaseSummary: [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" }, { index: 2, kind: rail.phase, outcome: "ok" }], settlementEvidence: [refTo(at(3), paid, "evidence")] });
        store.set(at(20), copy("buyer", scope)).set(at(21), copy("seller", scope));
        const graph = await buildCurrentEvidenceGraph(at(20), {
          read: async (locator) => store.get(locator) ?? null,
          readAnchorRecord: async (locator) => ({ data: store.get(locator)!, programName: `dacs4:payment:${JOB}:${rail.phase}:2` }),
          resolveListing: async () => ({ locator: at(1), raw: listed }),
        });
        assert.equal(graph.signaturesVerified, true, `${rail.phase}: ${name}`);
        assert.equal(graph.refsVerified, expected, `${rail.phase}: ${name}: ${graph.reason}`);
        const seller = await indexSeller([binding("buyer", at(20), BUYER), binding("seller", at(21), SELLER)], [], rail.phase);
        // AP2, HTLC, tank and receipt-only x402 intentionally have no supported SB-1 key.
        const counted = expected && ["pay-dem", "pay-evm-erc20", "pay-solana-spl", "pay-x402"].includes(rail.phase) && name !== "provider receipt";
        assert.equal(seller.deals[0].refsVerified, expected, `${rail.phase}: ${name}: catalog reference status`);
        assert.equal(seller.deals[0].reputationEligible, counted, `${rail.phase}: ${name}`);
        assert.equal(seller.reputation.completed, counted ? 1 : 0, `${rail.phase}: ${name}`);
        assert.deepEqual(seller.reputation.observedTransactionalVolume, counted ? [{ currency: "DEM", amount: "2" }] : [], `${rail.phase}: ${name}`);
        });
      }
    }
  } finally { store.clear(); for (const [key, raw] of original) store.set(key, raw); }
});

test("required vet execution and both parties' passing records precede completed graph and catalog admission", async (t) => {
  const original = new Map(store);
  try {
    const requirement = { requirementVersion: "1", required: [{ scheme: "lei", verificationRequired: true, recipeVersion: 1 }] };
    const listedScope = { ...listingScope, buyerRequirement: requirement,
      pipeline: [{ kind: "vet-credentials" }, { kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "pay-dem", parameters: { rail: "pay-dem" } }] };
    const attestation = { authority: "registry", decision: "pass" };
    const resultScope = { resultVersion: "1", scheme: "lei", identifier: "5493001KJTIIGC8Y1R12", recipeVersion: 1,
      method: "verifiable-credential", decision: "pass", reason: "registry match", fetchedAt: 10, verifiedAt: 20,
      attestation: { anchor: { kind: "storage-program", locator: at(80) }, contentHash: contentHash(attestation) } };
    const result = { ...resultScope, signature: signedWith(resultScope, "verify-result", OUTSIDER) };
    const resultRef = { ...refTo(at(81), result, "verify-result"), recipeVersion: 1 };
    const composite = (party: number, change: Obj = {}) => {
      const scope = { recordVersion: "1", jobId: JOB, evaluatedParty: dids[party], bundleHash: (party === BUYER ? "a" : "b").repeat(64),
        requirementHash: contentHash(party === BUYER ? requirement : { requirementVersion: "1", required: [] }),
        freshness: party === BUYER ? [resultRef] : [], dealSpecific: [], supplementary: [], overallDecision: "pass", generatedAt: 30, ...change };
      return { ...scope, signature: signedWith(scope, "composite", OUTSIDER) };
    };
    const cases: Array<[string, Obj[], Obj[], boolean, Obj?]> = [
      ["omitted vet execution", [1, 2, 3].map((index) => ({ index, kind: listedScope.pipeline[index].kind, outcome: "ok" })), [], false],
      ["ok summary without records", [0, 1, 2, 3].map((index) => ({ index, kind: listedScope.pipeline[index].kind, outcome: "ok" })), [], false],
      ["buyer record alone", [], [composite(BUYER)], false],
      ["seller record alone", [], [composite(SELLER)], false],
      ["wrong requirement", [], [composite(BUYER, { requirementHash: "0".repeat(64) }), composite(SELLER)], false],
      ["failed buyer vet", [], [composite(BUYER, { overallDecision: "fail" }), composite(SELLER)], false],
      ["empty required verification", [], [composite(BUYER, { freshness: [] }), composite(SELLER)], false],
      ["both parties passed", [], [composite(BUYER), composite(SELLER)], true],
      ["unsatisfied oneOf", [], [composite(BUYER), composite(SELLER)], false, { ...requirement, oneOf: [[{ scheme: "passport", verificationRequired: true }]] }],
      ["oneOf passing alternative", [], [composite(BUYER), composite(SELLER)], true, { ...requirement, oneOf: [[{ scheme: "passport", verificationRequired: true }, { scheme: "lei", verificationRequired: true }]] }],
      ["every oneOf group must pass", [], [composite(BUYER), composite(SELLER)], false, { ...requirement, oneOf: [[{ scheme: "lei", verificationRequired: true }], [{ scheme: "passport", verificationRequired: true }]] }],
    ];
    for (const [name, summary, records, expected, requirementOverride] of cases) {
      await t.test(name, async () => {
      store.clear(); for (const [key, raw] of original) store.set(key, raw);
      const caseListingScope = { ...listedScope, buyerRequirement: requirementOverride ?? requirement };
      const caseListed = { ...caseListingScope, signature: signedWith(caseListingScope, "listing", SELLER) };
      const casePinned = { ...listingRef, contentHash: artifactHash(caseListed, "listing") };
      const caseAgreementScope = { ...agreementScope, listingRef: casePinned };
      const caseAgreed = { ...caseAgreementScope, signatures: [signedWith(caseAgreementScope, "agreement", BUYER, "party"), signedWith(caseAgreementScope, "agreement", SELLER, "party")] };
      store.set(at(1), caseListed).set(at(2), caseAgreed).set(at(80), attestation).set(at(81), result);
      const refs = records.map((record, index) => {
        if (requirementOverride && record.evaluatedParty === dids[BUYER]) {
          const scope: Obj = { ...record, requirementHash: contentHash(requirementOverride) }; delete scope.signature;
          record = { ...scope, signature: signedWith(scope, "composite", OUTSIDER) };
        }
        store.set(at(70 + index), record); return refTo(at(70 + index), record, "composite");
      });
      const scope = bundleScope({ listingRef: casePinned, agreementRef: refTo(at(2), caseAgreed, "agreement"), vetRecords: refs,
        phaseSummary: summary.length ? summary : listedScope.pipeline.map((phase, index) => ({ index, kind: phase.kind, outcome: "ok" })) });
      store.set(at(20), copy("buyer", scope)).set(at(21), copy("seller", scope));
      const graph = await buildCurrentEvidenceGraph(at(20), {
        read: async (locator) => store.get(locator) ?? null,
        readAnchorRecord: async (locator) => ({ data: store.get(locator)!, programName: `dacs4:payment:${JOB}:pay-dem:3` }),
        resolveListing: async () => ({ locator: at(1), raw: caseListed }),
      });
      assert.equal(graph.signaturesVerified, true, name);
      assert.equal(graph.ok, expected, `${name}: ${graph.reason}`);
      const seller = await indexSeller([binding("buyer", at(20), BUYER), binding("seller", at(21), SELLER)], [], "pay-dem", 3);
      assert.equal(seller.deals[0].refsVerified, expected, name);
      assert.equal(seller.deals[0].reputationEligible, expected, name);
      assert.equal(seller.reputation.completed, expected ? 1 : 0, name);
      assert.deepEqual(seller.reputation.observedTransactionalVolume, expected ? [{ currency: "DEM", amount: "2" }] : [], name);
      });
    }
  } finally { store.clear(); for (const [key, raw] of original) store.set(key, raw); }
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
