import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { isCompositeVerificationRecord, isLegacyMvpListing, isLegacyMvpSettlementEvidence } from "@kynesyslabs/dacs/artifacts";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import type { RegisteredDeal, SellerRecord } from "../src/catalog/types.js";

// The legacy SDK-MVP two-copy reader (indexer `verifyCopy`). The routing read
// sends every `bundleVersion: "1"` copy to the current verifier, so this reader
// sees a legacy bundle only when that first read failed and a later read in the
// same pass succeeded. Each guard on that path must still fail closed.
process.env.DACS_DIRECTORY_DATA = mkdtempSync(join(tmpdir(), "dacs-directory-legacy-deals-"));
process.env.DEMOS_RPC = "https://node.test";
const store = await import("../src/catalog/store.js");
const { indexRegistration } = await import("../src/catalog/indexer.js");
const { deriveAnchorAddress } = await import("../src/catalog/chain.js");
const { legacySessionAnchorName } = await import("../src/catalog/legacySessionAnchorName.js");

type Obj = Record<string, unknown>;
const seeds = [41, 42, 43].map((byte) => Uint8Array.from(Buffer.alloc(32, byte)));
const dids = seeds.map((seed) => `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`);
const [buyer, seller, outsider] = dids;
const locator = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;
const signWith = (index: number, message: string, encoding: "hex" | "base64url") =>
  Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKeyFromSeed(seeds[index]))).toString(encoding);
const partySignature = (index: number, prefix: string, scope: Obj) =>
  ({ party: dids[index], algorithm: "ed25519", value: signWith(index, prefix + contentHash(scope), "base64url") });

const listingScope: Obj = {
  agentId: seller, serviceId: "svc", name: "Service", description: "Legacy service", claimRequirements: [],
  supportedNegotiation: ["negotiate-fixed-price"], supportedPaymentRails: ["pay-dem"], supportedDelivery: ["deliver-attested-payload"],
};

let storage: Record<string, Obj> = {};
let reads = new Map<string, number>();
/** Locators whose first read fails, as on a transient node error. */
let flaky = new Set<string>();
globalThis.fetch = async (input) => {
  const path = new URL(String(input)).pathname;
  if (!path.startsWith("/storage-program/")) return new Response(null, { status: 503 });
  const at = path.slice("/storage-program/".length);
  const count = (reads.get(at) ?? 0) + 1;
  reads.set(at, count);
  if (!storage[at] || (flaky.has(at) && count === 1)) return new Response(null, { status: 503 });
  return Response.json({ success: true, owner: `0x${(at === locator(1) ? seller : buyer).slice(-64)}`, programName: "opaque", data: storage[at] });
};

interface Copy { role: "buyer" | "seller" | "orchestrator"; signers?: number[]; change?: (body: Obj) => void }
interface LegacyDealOptions { listing?: Obj; agreement?: Obj }

/** A complete legacy graph: Listing, two-party agreement and one copy per role. */
function legacyDeal(jobId: string, copies: [Copy, Copy], options: LegacyDealOptions = {}): RegisteredDeal {
  const signedListingScope = { ...listingScope, ...options.listing };
  const agreementScope: Obj = {
    jobId, pattern: "fixed-price", buyer, seller, listingRef: locator(1),
    price: { amount: "1", asset: "DEM", decimals: 18, rail: "pay-dem" },
    delivery: { phase: "deliver-attested-payload", format: "application/json" }, expiresAt: "2099-01-01T00:00:00.000Z",
    ...options.agreement,
  };
  const agreement = { ...agreementScope, signatures: [0, 1].map((index) => partySignature(index, "dacs-agreement:v1:", agreementScope)) };
  storage[deriveAnchorAddress(buyer, legacySessionAnchorName.agreement(jobId))] = agreement;
  const [buyerAt, sellerAt] = [locator(10), locator(11)];
  for (const [index, copy] of copies.entries()) {
    const body: Obj = {
      bundleVersion: "1", jobId, outcome: "completed",
      listingRef: { listingId: "svc", version: 1, contentHash: contentHash(signedListingScope) },
      agreementRef: { kind: "dacs-3-agreement", id: `agreement-${jobId}`, contentHash: contentHash(agreementScope) },
      parties: [
        { role: "buyer", primaryClaim: buyer, bundleHash: "b".repeat(64) },
        { role: "seller", primaryClaim: seller, bundleHash: "s".repeat(64) },
      ],
      phaseSummary: [{ index: 0, kind: "commit-agreement", outcome: "ok" }], vetRecords: [], settlementEvidence: [],
      recipeRegistryVersion: 1, railRegistryVersion: 1, finalisedAt: 1_700_000_000_000,
    };
    copy.change?.(body);
    storage[index === 0 ? buyerAt : sellerAt] = {
      ...body,
      signatures: (copy.signers ?? [0, 1]).map((signer) => partySignature(signer, "dacs-bundle:v1:", body)),
      anchoredByRole: copy.role,
    };
  }
  storage[locator(1)] = { ...signedListingScope,
    signature: signWith(1, `dacs-listing:v1:${contentHash(signedListingScope)}`, "hex") };
  flaky = new Set([buyerAt, sellerAt]);
  return { jobId, rail: "pay-dem", buyerBundleRef: buyerAt, sellerBundleRef: sellerAt, owners: { buyer, seller } };
}

async function indexed(deal: RegisteredDeal, primaryClaim = seller, listingAnchors: string[] = []) {
  reads = new Map();
  const record = await indexRegistration({ primaryClaim, displayName: "Seller", listingAnchors, deals: [deal] },
    undefined, async () => { throw new Error("identity unavailable"); });
  storage = {};
  return record;
}

test("a fully signed legacy two-copy deal retains authenticated agreement verification", async () => {
  const registered = legacyDeal("legacy-ok", [{ role: "buyer" }, { role: "seller" }]);
  const scope = { ...storage[registered.buyerBundleRef] };
  delete scope.signatures;
  delete scope.anchoredByRole;
  const record = await indexed(registered);
  const [deal] = record.deals;
  assert.equal(deal.outcome, "completed", "the legacy reader read and shape-checked both copies");
  assert.equal(deal.signatureVerified, true, "both parties signed the copy");
  assert.equal(deal.anchoredByRole, "seller", "the authenticated seller copy is preferred");
  assert.equal(deal.bundleContentHash, contentHash(scope), "the root callback captures precisely the signed scope");
  assert.equal(deal.finalisedAt, 1_700_000_000_000);
  assert.equal(deal.sellerOutcome, "completed");
  assert.equal(deal.refsVerified, true);
  assert.equal(deal.verificationLimitation, undefined);
  assert.equal(deal.reputationEligible, true);
  assert.equal(record.reputation.bundleCount, 1);
});

/** Check projection separately from authentication, at both catalog count surfaces. */
function assertLegacyObservation(record: SellerRecord, registered: RegisteredDeal, count: 0 | 1) {
  assert.equal(record.deals.length, 1);
  const [deal] = record.deals;
  assert.equal(deal.outcome, "completed");
  assert.equal(deal.signatureVerified, true);
  assert.equal(deal.refsVerified, true, "payment projection must not replace reference authentication");
  assert.equal(deal.anchoredByRole, "seller");
  assert.equal(deal.reputationEligible, count === 1);
  assert.deepEqual(deal.settlementTxIds, [], "historical records supply no PC-2 settlement claim");
  assert.equal(record.reputation.completed, count);
  assert.equal(record.reputation.totalAgreements, count);
  assert.equal(record.reputation.bundleCount, count);
  assert.equal(record.reputation.bundleRefs?.length, count);
  assert.equal(record.listings.length, 1, "the signed legacy listing is registered and verified");
  assert.equal(record.listings[0].listingId, "svc");
  assert.equal(record.listings[0].artifactProfile, "legacy-sdk-v0.1");
  assert.equal(deal.category, record.listings[0].offering.category);
  assert.equal(record.listings[0].reputationHint?.bundleCount, count);
  for (const at of [registered.buyerBundleRef, registered.sellerBundleRef!]) {
    assert.ok((reads.get(at) ?? 0) >= 2, "the failed routing read is followed by a legacy verification read");
  }
}

test("legacy payment projection retains the signed phase summary and listing pipeline", async (t) => {
  const pipeline = [{ kind: "commit-agreement" }, { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }];
  const cases: Array<{ name: string; kind: string; outcome?: string; listing?: Obj; count: 0 | 1 }> = [
    { name: "no-payment control", kind: "commit-agreement", count: 1 },
    { name: "ok settle without evidence", kind: "settle", count: 0 },
    { name: "ok payment handler without evidence", kind: "pay-dem", count: 0 },
    { name: "ok payment identified only by the listing pipeline", kind: "commit-agreement", listing: { pipeline }, count: 0 },
    { name: "failed payment does not need a successful claim", kind: "commit-agreement", outcome: "fail", listing: { pipeline }, count: 1 },
  ];
  for (const [index, entry] of cases.entries()) {
    await t.test(entry.name, async () => {
      const change = (body: Obj) => { body.phaseSummary = [{ index: 1, kind: entry.kind, outcome: entry.outcome ?? "ok" }]; };
      const registered = legacyDeal(`legacy-payment-context-${index}`, [{ role: "buyer", change }, { role: "seller", change }],
        { listing: entry.listing });
      const agreement = storage[deriveAnchorAddress(buyer, legacySessionAnchorName.agreement(registered.jobId))];
      assert.equal(agreement.pipeline, undefined, "the agreement cannot supply the listing's payment phase");
      assertLegacyObservation(await indexed(registered, seller, [locator(1)]), registered, entry.count);
    });
  }
});

test("authenticated historical success evidence reaches legacy payment projection", async (t) => {
  for (const outcome of ["success", "failure"] as const) {
    await t.test(outcome, async () => {
      const jobId = `legacy-payment-evidence-${outcome}`;
      const evidence: Obj = {
        evidenceVersion: "1", jobId, phase: "pay-dem", phaseIndex: 1, outcome,
        paymentTxRefs: outcome === "success" ? [{ kind: "demos", rail: "pay-dem", txHash: "a".repeat(64) }] : [],
        observedAt: 1_700_000_000_000,
        ...(outcome === "success" ? {
          paymentAmount: { amount: "1", currency: "DEM" },
          settlementFinality: { model: "bft-final", finalityObservedAt: 1_700_000_000_000 },
        } : {}),
      };
      assert.equal(isLegacyMvpSettlementEvidence(evidence), true, "the historical success/failure shape is admitted");
      const change = (body: Obj) => {
        // A non-payment summary cannot independently trigger the missing-claim guard.
        body.settlementEvidence = [{ kind: "dacs-4-evidence", id: `evidence-${jobId}`, contentHash: contentHash(evidence) }];
      };
      const registered = legacyDeal(jobId, [{ role: "buyer", change }, { role: "seller", change }]);
      storage[deriveAnchorAddress(buyer, legacySessionAnchorName.evidence(jobId))] = { ...evidence,
        signature: { algorithm: "ed25519", signer: buyer,
          value: signWith(0, `dacs-evidence:v1:${contentHash(evidence)}`, "base64url") } };
      assertLegacyObservation(await indexed(registered, seller, [locator(1)]), registered, outcome === "success" ? 0 : 1);
    });
  }
});

test("legacy additive pipeline kinds preserve authenticated non-payment history", async (t) => {
  const phases = [{ kind: null }, {}, { kind: 7 }, { kind: false }, { kind: {} }];
  for (const [index, phase] of phases.entries()) {
    await t.test(JSON.stringify(phase), async () => {
      const registered = legacyDeal(`legacy-additive-pipeline-${index}`, [{ role: "buyer" }, { role: "seller" }],
        { listing: { pipeline: [phase] } });
      assert.equal(isLegacyMvpListing(storage[locator(1)]), true, "the signed historical shape remains SDK-readable");
      assertLegacyObservation(await indexed(registered, seller, [locator(1)]), registered, 1);
    });
  }
});

test("legacy payment projection ignores success annotations on non-evidence artifacts", async (t) => {
  for (const kind of ["listing", "agreement"] as const) {
    await t.test(kind, async () => {
      const registered = legacyDeal(`legacy-non-evidence-${kind}`, [{ role: "buyer" }, { role: "seller" }],
        { [kind]: { outcome: "success" } });
      assertLegacyObservation(await indexed(registered, seller, [locator(1)]), registered, 1);
    });
  }
});

test("each legacy two-copy guard withholds reputation", async () => {
  const cases: Array<[string, () => RegisteredDeal, string?]> = [
    ["seller copy anchored by the buyer", () => legacyDeal("legacy-misrole", [{ role: "buyer" }, { role: "buyer" }])],
    ["copies diverge on a phase fact", () => legacyDeal("legacy-diverge", [{ role: "buyer" }, {
      role: "seller", change: (body) => { body.phaseSummary = [{ index: 0, kind: "commit-agreement", outcome: "fail" }]; },
    }])],
    ["seller copy is missing the seller's signature", () => legacyDeal("legacy-unsigned", [{ role: "buyer" }, { role: "seller", signers: [0] }])],
    ["buyer copy names another buyer", () => legacyDeal("legacy-other-buyer", [{
      role: "buyer", change: (body) => { (body.parties as Obj[])[0].primaryClaim = outsider; },
    }, { role: "seller" }])],
    ["copies belong to another job", () => legacyDeal("legacy-job", [{
      role: "buyer", change: (body) => { body.jobId = "another-job"; },
    }, { role: "seller", change: (body) => { body.jobId = "another-job"; } }])],
    ["catalog seller is not the bundle seller", () => legacyDeal("legacy-catalog", [{ role: "buyer" }, { role: "seller" }]), outsider],
  ];
  for (const [name, build, primaryClaim] of cases) {
    const record = await indexed(build(), primaryClaim);
    const [deal] = record.deals;
    assert.equal(deal.refsVerified, false, name);
    assert.equal(deal.reputationEligible, false, name);
    assert.equal(record.reputation.bundleCount, 0, name);
  }
});

test("an authenticated legacy seller copy reports its own outcome and SR-2 anchor time", async () => {
  const deal = legacyDeal("legacy-abort", [
    { role: "buyer", change: (body) => { body.outcome = "aborted-by-self"; } },
    { role: "seller", change: (body) => { body.outcome = "aborted-by-other"; } },
  ]);
  for (const [at, anchorTime] of [[deal.buyerBundleRef, 111], [deal.sellerBundleRef!, 222]] as const) {
    store.recordArtifact({ locator: at, kind: "bundle", profile: "legacy", observedAt: 1, contentHash: "a".repeat(64), anchorTime });
  }
  const [published] = (await indexed(deal)).deals;
  assert.equal(published.outcome, "aborted-by-other");
  assert.equal(published.sellerOutcome, "aborted-by-other", "the buyer's own abort is the seller's counterparty abort");
  assert.equal(published.anchorTimestamp, 222, "the reported copy is the seller's");
  assert.equal(published.reputationEligible, true);
});

test("a legacy deal with only one verifiable copy keeps its signature verdict but never counts", async () => {
  const deal = legacyDeal("legacy-one-copy", [{ role: "buyer" }, { role: "seller" }]);
  const [, sellerAt] = [deal.buyerBundleRef, deal.sellerBundleRef!];
  delete storage[sellerAt];
  const record = await indexed(deal);
  assert.equal(record.deals[0].outcome, "completed");
  assert.equal(record.deals[0].signatureVerified, true, "the buyer copy is signed by both parties");
  assert.equal(record.deals[0].refsVerified, false, "strict two-copy verification needs the seller copy");
  assert.equal(record.deals[0].reputationEligible, false);
  assert.equal(record.reputation.bundleCount, 0);
});

test("legacy anchor names are the historical producer's raw-jobId names", () => {
  // Literal names from the SDK-MVP producer this Directory indexed before this
  // release (dacs-sdk 44d8ff2, src/agent/runSessionCore.ts sessionAnchorName).
  // It never percent-encoded the job ID, so a delimiter stays raw.
  assert.equal(legacySessionAnchorName.agreement("job-1"), "dacs3:agreement:job-1");
  assert.equal(legacySessionAnchorName.evidence("job-1"), "dacs4:evidence:job-1");
  assert.equal(legacySessionAnchorName.vet("job-1"), "dacs2:verifyrecord:job-1");
  assert.equal(legacySessionAnchorName.vet("a:b"), "dacs2:verifyrecord:a:b");
  assert.equal(legacySessionAnchorName.agreement("a:b%2F"), "dacs3:agreement:a:b%2F");
});

test("a valid seller copy retains its metadata when the buyer copy is missing, malformed or unsigned", async () => {
  for (const failure of ["missing", "malformed", "unsigned"] as const) {
    const deal = legacyDeal(`legacy-${failure}`, [{ role: "buyer", signers: failure === "unsigned" ? [] : undefined }, { role: "seller" }]);
    if (failure === "missing") delete storage[deal.buyerBundleRef];
    if (failure === "malformed") storage[deal.buyerBundleRef] = { unexpected: true };
    const [published] = (await indexed(deal)).deals;
    assert.equal(published.signatureVerified, true, failure);
    assert.equal(published.refsVerified, false, failure);
    assert.equal(published.reputationEligible, false, failure);
    assert.equal(published.anchoredByRole, "seller", failure);
    assert.equal(published.outcome, "completed", failure);
    assert.equal(published.finalisedAt, 1_700_000_000_000, failure);
  }
});

test("an unauthenticated orchestrator copy cannot give a valid seller copy reputation", async () => {
  const registered = legacyDeal("legacy-orchestrator", [{ role: "orchestrator" }, { role: "seller" }]);
  const [published] = (await indexed(registered)).deals;
  assert.equal(published.anchoredByRole, "seller");
  assert.equal(published.signatureVerified, true);
  assert.equal(published.refsVerified, false);
  assert.equal(published.reputationEligible, false);
});

test("a rejected legacy verifier publishes a false signature verdict and no invented metadata", async () => {
  const deal = legacyDeal("legacy-rejected-verifier", [{ role: "buyer" }, { role: "seller" }]);
  reads = new Map();
  let calls = 0;
  const record = await indexRegistration({ primaryClaim: seller, displayName: "Seller", listingAnchors: [], deals: [deal] },
    undefined, async () => ({}), undefined, undefined, async () => {
      calls++;
      throw new Error("SDK read rejected");
    });
  assert.equal(calls, 2, "both verifier promises rejected");
  assert.equal(record.deals.length, 1);
  assert.equal(record.deals[0].signatureVerified, false, "there is no SDK verification result");
  assert.equal(record.deals[0].refsVerified, false);
  assert.equal(record.deals[0].reputationEligible, false);
  assert.equal(record.deals[0].outcome, undefined);
  assert.equal(record.deals[0].bundleContentHash, undefined);
  assert.equal(record.reputation.bundleCount, 0);
  storage = {};
});

test("infrastructure errors during legacy verification abort indexing and preserve the persisted catalog", async () => {
  const prior = { catalogVersion: "1" as const, generatedAt: 7, sellers: [] };
  store.saveCatalog(prior);
  for (const code of ["SQLITE_IOERR", "EIO", "ENOSPC"]) {
    const deal = legacyDeal(`legacy-infrastructure-${code}`, [{ role: "buyer" }, { role: "seller" }]);
    reads = new Map();
    const failure = Object.assign(new Error("persistent storage unavailable"), { code });
    const omissions: Array<[string, number]> = [];
    await assert.rejects(indexRegistration({ primaryClaim: seller, displayName: "Seller", listingAnchors: [], deals: [deal] },
      undefined, async () => ({}), undefined, (kind, count) => omissions.push([kind, count]), async () => { throw failure; }),
    (error) => error === failure);
    assert.deepEqual(store.loadCatalog(), prior);
    assert.equal(omissions.some(([kind]) => kind === "deals"), false);
    storage = {};
  }
});

test("an ordinary per-deal exception reports exactly one omission and keeps the next deal", async () => {
  const deal = legacyDeal("legacy-ordinary-error", [{ role: "buyer" }, { role: "seller" }]);
  reads = new Map();
  const next = { ...deal, jobId: "next-deal", buyerBundleRef: locator(90), sellerBundleRef: locator(91) };
  let firstRead = true;
  const originalRef = deal.buyerBundleRef;
  Object.defineProperty(deal, "buyerBundleRef", { enumerable: true, get() {
    if (firstRead) { firstRead = false; throw new Error("one deal cannot be processed"); }
    return originalRef;
  } });
  const omissions: Array<[string, number]> = [];
  const record = await indexRegistration({ primaryClaim: seller, displayName: "Seller", listingAnchors: [], deals: [deal, next] },
    undefined, async () => ({}), undefined, (kind, count) => omissions.push([kind, count]));
  assert.deepEqual(omissions.filter(([kind]) => kind === "deals"), [["deals", 1]]);
  assert.equal(record.deals.length, 2);
  assert.deepEqual(record.deals.map((d) => d.jobId), ["legacy-ordinary-error", "next-deal"]);
  assert.equal(record.deals[0].signatureVerified, false);
  assert.equal(record.deals[0].refsVerified, false);
  assert.equal(record.deals[0].reputationEligible, false);
  storage = {};
});

test("legacy discovery requires the expected buyer and both authenticated party signatures", async () => {
  const { validAgreementForDiscovery } = await import("../src/catalog/scan.js");
  const jobId = "legacy-discovery";
  legacyDeal(jobId, [{ role: "buyer" }, { role: "seller" }]);
  const agreement = storage[deriveAnchorAddress(buyer, legacySessionAnchorName.agreement(jobId))];
  assert.equal(await validAgreementForDiscovery(agreement, jobId, buyer), true);
  assert.equal(await validAgreementForDiscovery(agreement, jobId, outsider), false);
  assert.equal(await validAgreementForDiscovery(agreement, "foreign-job", buyer), false);
  assert.equal(await validAgreementForDiscovery({ ...agreement, price: null }, jobId, buyer), false);
  for (const signatures of [undefined, [], (agreement.signatures as Obj[]).slice(0, 1),
    (agreement.signatures as Obj[]).slice(1),
    (agreement.signatures as Obj[]).map(s => ({ ...s, value: "invalid" }))]) {
    assert.equal(await validAgreementForDiscovery({ ...agreement, signatures }, jobId, buyer), false);
  }
});


test("legacy agreement authentication rejects missing, invalid and foreign party signatures", async () => {
  for (const mode of ["missing", "buyer-only", "invalid", "foreign"] as const) {
    const jobId = `legacy-auth-${mode}`;
    const deal = legacyDeal(jobId, [{ role: "buyer" }, { role: "seller" }]);
    const agreement = storage[deriveAnchorAddress(buyer, legacySessionAnchorName.agreement(jobId))];
    if (mode === "missing") delete agreement.signatures;
    if (mode === "buyer-only") agreement.signatures = (agreement.signatures as Obj[]).slice(0, 1);
    if (mode === "invalid") (agreement.signatures as Obj[])[1].value = "A".repeat(86);
    if (mode === "foreign") (agreement.signatures as Obj[])[1].party = outsider;
    const record = await indexed(deal);
    assert.equal(record.deals[0].refsVerified, false, mode);
    assert.equal(record.reputation.bundleCount, 0, mode);
  }
});


test("legacy evidence is independently authenticated before the two-copy deal counts", async () => {
  for (const mode of ["valid", "orchestrator", "missing", "invalid", "foreign", "seller", "tampered"] as const) {
    const jobId = `legacy-evidence-${mode}`;
    const evidence: Obj = { evidenceVersion: "1", jobId, phase: "pay-dem", phaseIndex: 1,
      outcome: "failure", paymentTxRefs: [], observedAt: 1700000000000 };
    const deal = legacyDeal(jobId, [{ role: "buyer" }, { role: "seller" }]);
    const signed: Obj = { ...evidence, signature: {
      algorithm: "ed25519", signer: mode === "foreign" || mode === "orchestrator" ? outsider : mode === "seller" ? seller : buyer,
      value: signWith(mode === "foreign" || mode === "orchestrator" ? 2 : mode === "seller" ? 1 : 0, `dacs-evidence:v1:${contentHash(evidence)}`, "base64url"),
    } };
    if (mode === "missing") delete signed.signature;
    if (mode === "invalid") (signed.signature as Obj).value = "A".repeat(86);
    if (mode === "tampered") signed.observedAt = 42;
    storage[deriveAnchorAddress(buyer, legacySessionAnchorName.evidence(jobId))] = signed;
    for (const at of [deal.buyerBundleRef, deal.sellerBundleRef!]) {
      const body = { ...storage[at] }; delete body.signatures; delete body.anchoredByRole;
      if (mode === "orchestrator") (body.parties as Obj[]).push({ role: "orchestrator", primaryClaim: outsider, bundleHash: "o".repeat(64) });
      body.settlementEvidence = [{ kind: "dacs-4-evidence", id: `evidence-${jobId}`, contentHash: contentHash(evidence) }];
      storage[at] = { ...body, anchoredByRole: storage[at].anchoredByRole,
        signatures: (mode === "orchestrator" ? [0, 1, 2] : [0, 1]).map(index => partySignature(index, "dacs-bundle:v1:", body)) };
    }
    const record = await indexed(deal);
    const allowed = mode === "valid" || mode === "orchestrator";
    assert.equal(record.deals[0].refsVerified, allowed, mode);
    assert.equal(record.reputation.bundleCount, allowed ? 1 : 0, mode);
  }
});


test("historical hex agreement signatures retain their authenticated read profile", async () => {
  const jobId = "legacy-hex-agreement";
  const deal = legacyDeal(jobId, [{ role: "buyer" }, { role: "seller" }]);
  const agreement = storage[deriveAnchorAddress(buyer, legacySessionAnchorName.agreement(jobId))];
  for (const signature of agreement.signatures as Obj[]) signature.value = Buffer.from(signature.value as string, "base64url").toString("hex");
  assert.equal((await indexed(deal)).deals[0].refsVerified, true);
});

test("legacy vet references read the buyer's historical verifyrecord separately from agreement and evidence", async () => {
  for (const mode of ["well-shaped", "missing", "wrong-document", "wrong-name", "tampered"] as const) {
    const jobId = `legacy-vet-${mode}`;
    const deal = legacyDeal(jobId, [{ role: "buyer" }, { role: "seller" }]);
    const vetScope: Obj = { recordVersion: "1", jobId, evaluatedParty: seller,
      bundleHash: "a".repeat(64), requirementHash: "b".repeat(64), generatedAt: 1700000000000,
      freshness: [], supplementary: [], dealSpecific: [], overallDecision: "pass" };
    const vet = { ...vetScope, signature: { algorithm: "ed25519", signer: outsider,
      value: signWith(2, `dacs-composite:v1:${contentHash(vetScope)}`, "base64url") } };
    assert.equal(isCompositeVerificationRecord(vet), true, "the unsupported control passes the pinned shape gate");
    const evidenceScope: Obj = { evidenceVersion: "1", jobId, phase: "pay-dem", phaseIndex: 1,
      outcome: "failure", paymentTxRefs: [], observedAt: 1700000000000 };
    const evidence = { ...evidenceScope, signature: { algorithm: "ed25519", signer: buyer,
      value: signWith(0, `dacs-evidence:v1:${contentHash(evidenceScope)}`, "base64url") } };
    // Literal historical producer names, deliberately independent of the dispatch helper.
    const vetAt = deriveAnchorAddress(buyer, `dacs2:verifyrecord:${jobId}`);
    const evidenceAt = deriveAnchorAddress(buyer, `dacs4:evidence:${jobId}`);
    const agreementAt = deriveAnchorAddress(buyer, `dacs3:agreement:${jobId}`);
    assert.equal(new Set([vetAt, evidenceAt, agreementAt]).size, 3);
    storage[evidenceAt] = evidence;
    const wrongAt = deriveAnchorAddress(buyer, `dacs2:verifyresult:${jobId}`);
    if (mode === "wrong-name") storage[wrongAt] = vet;
    else if (mode !== "missing") storage[vetAt] = mode === "wrong-document" ? evidence
      : mode === "tampered" ? { ...vet, overallDecision: "fail" } : vet;
    for (const at of [deal.buyerBundleRef, deal.sellerBundleRef!]) {
      const body = { ...storage[at] }; delete body.signatures; delete body.anchoredByRole;
      body.vetRecords = [{ kind: "dacs-2-verifyresult", id: `vet-${jobId}`, contentHash: contentHash(vetScope) }];
      body.settlementEvidence = [{ kind: "dacs-4-evidence", id: `evidence-${jobId}`, contentHash: contentHash(evidenceScope) }];
      storage[at] = { ...body, anchoredByRole: storage[at].anchoredByRole,
        signatures: [0, 1].map(index => partySignature(index, "dacs-bundle:v1:", body)) };
    }
    const record = await indexed(deal);
    assert.equal(reads.get(vetAt), 2, `${mode}: each copy reads buyer-owned dacs2:verifyrecord`);
    assert.equal(reads.get(wrongAt) ?? 0, 0, "no alternate name can substitute for the historical producer name");
    assert.equal(reads.get(agreementAt), 2, "agreement dispatch remains separate");
    assert.equal(reads.get(evidenceAt), 2, "evidence dispatch remains separate");
    assert.equal(record.deals[0].signatureVerified, true, mode);
    // This release has no authenticated session recipe/composite adapter. A
    // shaped and signed record alone cannot establish a completed vet graph.
    assert.equal(record.deals[0].refsVerified, false, mode);
    assert.equal(record.deals[0].reputationEligible, false, mode);
    assert.equal(record.deals[0].verificationLimitation, "legacy-vet-unsupported", mode);
    assert.equal(record.reputation.bundleCount, 0, mode);
    store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [record] });
    const { GET } = await import("../app/api/dacs/status/route.js");
    const status = await (await GET(new NextRequest("https://directory.test/api/dacs/status"))).json();
    assert.equal(status.legacyVetUnsupportedDeals, 1, "two copies contribute one diagnostic deal");
  }
});
