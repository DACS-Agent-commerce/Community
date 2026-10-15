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

interface Copy { role: "buyer" | "seller"; signers?: number[]; change?: (body: Obj) => void }

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
  const record = await indexed(legacyDeal("legacy-ok", [{ role: "buyer" }, { role: "seller" }]));
  const [deal] = record.deals;
  assert.equal(deal.outcome, "completed", "the legacy reader read and shape-checked both copies");
  assert.equal(deal.signatureVerified, true, "both parties signed the copy");
  assert.equal(deal.anchoredByRole, "buyer", "no copy passed the strict policy, so the buyer copy is reported");
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
