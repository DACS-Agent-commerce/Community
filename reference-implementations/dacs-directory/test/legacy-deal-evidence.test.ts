import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import type { RegisteredDeal } from "../src/catalog/types.js";

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
const listing = { ...listingScope, signature: signWith(1, `dacs-listing:v1:${contentHash(listingScope)}`, "hex") };

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

/** A complete legacy graph: Listing, two-party agreement and one copy per role. */
function legacyDeal(jobId: string, copies: [Copy, Copy]): RegisteredDeal {
  const agreementScope: Obj = {
    jobId, pattern: "fixed-price", buyer, seller, listingRef: locator(1),
    price: { amount: "1", asset: "DEM", decimals: 18, rail: "pay-dem" },
    delivery: { phase: "deliver-attested-payload", format: "application/json" }, expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const agreement = { ...agreementScope, signatures: [0, 1].map((index) => partySignature(index, "dacs-agreement:v1:", agreementScope)) };
  storage[deriveAnchorAddress(buyer, legacySessionAnchorName.agreement(jobId))] = agreement;
  const [buyerAt, sellerAt] = [locator(10), locator(11)];
  for (const [index, copy] of copies.entries()) {
    const body: Obj = {
      bundleVersion: "1", jobId, outcome: "completed",
      listingRef: { listingId: "svc", version: 1, contentHash: contentHash(listingScope) },
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
  storage[locator(1)] = listing;
  flaky = new Set([buyerAt, sellerAt]);
  return { jobId, rail: "pay-dem", buyerBundleRef: buyerAt, sellerBundleRef: sellerAt, owners: { buyer, seller } };
}

async function indexed(deal: RegisteredDeal, primaryClaim = seller) {
  reads = new Map();
  const record = await indexRegistration({ primaryClaim, displayName: "Seller", listingAnchors: [], deals: [deal] },
    undefined, async () => { throw new Error("identity unavailable"); });
  storage = {};
  return record;
}

test("a fully signed legacy two-copy deal never counts: the pinned SDK authenticates no legacy agreement", async () => {
  // verifyBundleCore reports every legacy agreement reference as `signature-missing`
  // (legacy-agreement-signatures-missing), so the strict reference policy cannot pass.
  const registered = legacyDeal("legacy-ok", [{ role: "buyer" }, { role: "seller" }]);
  const scope = { ...storage[registered.buyerBundleRef] };
  delete scope.signatures;
  delete scope.anchoredByRole;
  const record = await indexed(registered);
  const [deal] = record.deals;
  assert.equal(deal.outcome, "completed", "the legacy reader read and shape-checked both copies");
  assert.equal(deal.signatureVerified, true, "both parties signed the copy");
  assert.equal(deal.anchoredByRole, "buyer", "no copy passed the strict policy, so the buyer copy is reported");
  assert.equal(deal.bundleContentHash, contentHash(scope), "the root callback captures precisely the signed scope");
  assert.equal(deal.finalisedAt, 1_700_000_000_000);
  assert.equal(deal.sellerOutcome, "completed");
  assert.equal(deal.refsVerified, false);
  assert.equal(deal.reputationEligible, false);
  assert.equal(record.reputation.bundleCount, 0);
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

test("a legacy buyer-anchored copy reports the seller-relative outcome and its own SR-2 anchor time", async () => {
  const deal = legacyDeal("legacy-abort", [
    { role: "buyer", change: (body) => { body.outcome = "aborted-by-self"; } },
    { role: "seller", change: (body) => { body.outcome = "aborted-by-other"; } },
  ]);
  for (const [at, anchorTime] of [[deal.buyerBundleRef, 111], [deal.sellerBundleRef!, 222]] as const) {
    store.recordArtifact({ locator: at, kind: "bundle", profile: "legacy", observedAt: 1, contentHash: "a".repeat(64), anchorTime });
  }
  const [published] = (await indexed(deal)).deals;
  assert.equal(published.outcome, "aborted-by-self");
  assert.equal(published.sellerOutcome, "aborted-by-other", "the buyer's own abort is the seller's counterparty abort");
  assert.equal(published.anchorTimestamp, 111, "the reported copy is the buyer's");
  assert.equal(published.reputationEligible, false);
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

test("legacy public metadata distinguishes missing, malformed, and unsigned buyer copies", async () => {
  for (const failure of ["missing", "malformed", "unsigned"] as const) {
    const deal = legacyDeal(`legacy-${failure}`, [{ role: "buyer", signers: failure === "unsigned" ? [] : undefined }, { role: "seller" }]);
    if (failure === "missing") delete storage[deal.buyerBundleRef];
    if (failure === "malformed") storage[deal.buyerBundleRef] = { unexpected: true };
    const raw = storage[deal.buyerBundleRef];
    const [published] = (await indexed(deal)).deals;
    assert.equal(published.signatureVerified, false, failure);
    assert.equal(published.refsVerified, false, failure);
    assert.equal(published.reputationEligible, false, failure);
    if (failure !== "unsigned") {
      assert.equal(published.outcome, undefined, failure);
      assert.equal(published.anchoredByRole, undefined, failure);
      assert.equal(published.bundleContentHash, undefined, failure);
      assert.equal(published.finalisedAt, undefined, failure);
    } else {
      const scope = { ...raw };
      delete scope.signatures;
      delete scope.anchoredByRole;
      assert.equal(published.outcome, "completed");
      assert.equal(published.anchoredByRole, "buyer");
      assert.equal(published.bundleContentHash, contentHash(scope));
    }
  }
  const noDeals = await indexRegistration({ primaryClaim: seller, displayName: "Seller", listingAnchors: [] },
    undefined, async () => { throw new Error("identity unavailable"); });
  assert.deepEqual(noDeals.deals, []);
  assert.equal(noDeals.reputation.bundleCount, 0);
});

test("an unverified legacy orchestrator copy retains its reported role without reputation", async () => {
  const registered = legacyDeal("legacy-orchestrator", [{ role: "orchestrator" }, { role: "seller" }]);
  const [published] = (await indexed(registered)).deals;
  assert.equal(published.anchoredByRole, "orchestrator");
  assert.equal(published.signatureVerified, false);
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
