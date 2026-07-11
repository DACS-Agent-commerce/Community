import assert from "node:assert/strict";
import test from "node:test";

import { contentHash } from "@kynesyslabs/dacs/canonical";
import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
} from "@kynesyslabs/dacs/crypto";

import {
  bundleMatchesRegisteredDeal,
  dedupeVerifiedDeals,
  hasRequiredBundleSignatures,
  refsPassStrictPolicy,
} from "../src/catalog/bundlePolicy.js";
import { activeCatalogListings, activeCatalogSellers } from "../src/catalog/discovery.js";
import { indexRegistration } from "../src/catalog/indexer.js";
import {
  hasValidListingRevocation,
  ownerClaim,
  verifyListing,
} from "../src/catalog/listingVerification.js";
import { addRevocationCandidate } from "../src/catalog/scan.js";
import { deriveSellerReputation, flipOutcome } from "../src/catalog/reputation.js";
import type { Catalog, DealRecord, SellerRecord } from "../src/catalog/types.js";
import type { BundleVerification } from "../vendor/dacs-sdk/dist/agent/verifyBundleCore.js";

const seed = Uint8Array.from(Buffer.alloc(32, 7));
const did = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;

const listing = {
  listingId: "svc",
  listingVersion: 1,
  agentId: did,
  serviceId: "svc",
  name: "Service",
  description: "Description",
  claimRequirements: [],
  supportedNegotiation: ["negotiate-fixed-price"],
  supportedPaymentRails: ["pay-dem"],
  supportedDelivery: ["deliver-attested-payload"],
};

test("listing verification requires a valid signer-bound envelope", async () => {
  const message = Buffer.from(`dacs-listing:v1:${contentHash(listing)}`, "utf8");
  const value = Buffer.from(await ed25519Sign(message, privateKeyFromSeed(seed))).toString("hex");
  const signed = { ...listing, signature: { algorithm: "ed25519", signer: did, value } };
  assert.ok(await verifyListing(signed));
  assert.equal(await verifyListing({ ...signed, name: "tampered" }), null);
  assert.equal(await verifyListing({ ...listing, signature: "deadbeef" }), null);
  assert.equal(ownerClaim(`0x${did.slice(-64)}`), did);
});

test("listing verification accepts the legacy compact signature without weakening signer binding", async () => {
  const message = Buffer.from(`dacs-listing:v1:${contentHash(listing)}`, "utf8");
  const value = Buffer.from(await ed25519Sign(message, privateKeyFromSeed(seed))).toString("hex");
  assert.ok(await verifyListing({ ...listing, signature: value }));
  assert.equal(await verifyListing({ ...listing, agentId: `did:demos:agent:${"9".repeat(64)}`, signature: value }), null);
});

test("listing verification accepts a current structured listing and verifies its IdentityBundle", async () => {
  const identityScope = {
    bundleVersion: "1",
    presentedBy: did,
    presentedAt: 1,
    claims: [{ ref: did }],
  };
  const identitySignature = Buffer.from(await ed25519Sign(
    Buffer.from(`dacs-bundle-presentation:v1:${contentHash(identityScope)}`, "utf8"),
    privateKeyFromSeed(seed),
  )).toString("hex");
  const currentScope = {
    dacsVersion: "1",
    listingVersion: 1,
    listingId: "svc",
    requiredCapabilities: ["SR-2"],
    seller: {
      identity: {
        ...identityScope,
        presentation: { kind: "per-claim", signatures: [{ ref: did, signature: identitySignature }] },
      },
      displayName: "Service agent",
      publicEndpoint: "https://agent.example/a2a",
    },
    offering: {
      title: "Service",
      description: "Description",
      category: "services.test",
      tags: ["test"],
      deliverable: { kind: "attested-payload", payloadFormat: "application/json" },
    },
    buyerRequirement: { requirementVersion: "1", required: [], preferredPresentation: "any" },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-agreement" },
      { kind: "pay-dem", parameters: { rail: "pay-dem" } },
      { kind: "deliver-attested-payload" },
    ],
    pricing: { kind: "fixed", price: { amount: "1", currency: "DEM", unit: "per-job" } },
    acceptedRails: [{ railId: "pay-dem" }],
    terms: {},
    validity: { notBefore: 1 },
  };
  const value = Buffer.from(await ed25519Sign(
    Buffer.from(`dacs-listing:v1:${contentHash(currentScope)}`, "utf8"),
    privateKeyFromSeed(seed),
  )).toString("hex");
  const signed = { ...currentScope, signature: { algorithm: "ed25519", signer: did, value } };
  const verified = await verifyListing(signed);
  assert.equal(verified?.profile, "dacs-v0.1");
  assert.equal(verified?.sellerClaim, did);
  assert.equal(await verifyListing({ ...signed, offering: { ...signed.offering, title: "tampered" } }), null);
});

function result(outcome: string, signatures: BundleVerification["signatures"]): BundleVerification {
  return {
    ok: true,
    fullyVerified: signatures.every((s) => s.verdict === "valid"),
    signatures,
    refs: [],
    bundle: {
      bundleVersion: "1",
      jobId: "j",
      outcome,
      listingRef: { listingId: "svc", version: 1, contentHash: "h" },
      agreementRef: { kind: "dacs-3-agreement", id: "a", contentHash: "h" },
      parties: [
        { role: "buyer", primaryClaim: "buyer", bundleHash: "b" },
        { role: "seller", primaryClaim: "seller", bundleHash: "s" },
      ],
      phaseSummary: [],
      vetRecords: [],
      settlementEvidence: [],
      recipeRegistryVersion: 1,
      railRegistryVersion: 1,
      finalisedAt: 1,
    },
  };
}

test("strict bundle policy rejects one-sided completed bundles", () => {
  assert.equal(hasRequiredBundleSignatures(result("completed", [{ party: "buyer", verdict: "valid" }])), false);
  assert.equal(hasRequiredBundleSignatures(result("completed", [
    { party: "buyer", verdict: "valid" },
    { party: "seller", verdict: "valid" },
  ])), true);
  assert.equal(hasRequiredBundleSignatures(result("aborted-by-other", [{ party: "buyer", verdict: "valid" }])), true);
});

test("reputation binding requires the submitted job and seller to match the signed bundle", () => {
  const verification = result("completed", [
    { party: "buyer", verdict: "valid" },
    { party: "seller", verdict: "valid" },
  ]);
  const deal = {
    jobId: "j",
    rail: "pay-dem",
    buyerBundleRef: `stor-${"a".repeat(40)}`,
    owners: { buyer: "buyer", seller: "seller" },
  };
  assert.equal(bundleMatchesRegisteredDeal(verification.bundle, deal, "seller"), true);
  assert.equal(bundleMatchesRegisteredDeal(verification.bundle, { ...deal, jobId: "replayed" }, "seller"), false);
  assert.equal(bundleMatchesRegisteredDeal(verification.bundle, deal, "victim"), false);
  assert.equal(
    bundleMatchesRegisteredDeal(verification.bundle, { ...deal, owners: { ...deal.owners, buyer: "other" } }, "seller"),
    false,
  );
});

test("verified reputation deals are unique by signed job and bundle reference", () => {
  const base: DealRecord = {
    jobId: "j",
    rail: "pay-dem",
    buyerBundleRef: `stor-${"a".repeat(40)}`,
    owners: { buyer: "buyer", seller: "seller" },
    signatureVerified: true,
    refsVerified: true,
    verifiedAt: 1,
  };
  const records = dedupeVerifiedDeals([
    base,
    { ...base },
    { ...base, buyerBundleRef: `stor-${"b".repeat(40)}` },
    { ...base, jobId: "other" },
    { ...base, jobId: "unverified", refsVerified: false },
  ]);
  assert.deepEqual(records.map((deal) => deal.jobId), ["j", "unverified"]);
});

test("DACS-5 scalar derivation uses seller perspective and neutral exclusions", () => {
  const deal = (jobId: string, sellerOutcome: string): DealRecord => ({
    jobId, rail: "pay-dem", buyerBundleRef: `stor-${jobId.padEnd(40, "a")}`,
    owners: { buyer: "buyer", seller: "seller" }, signatureVerified: true, refsVerified: true,
    reputationEligible: true, sellerOutcome, finalisedAt: 10, verifiedAt: 10,
    bundleContentHash: jobId.padEnd(64, "b"),
  });
  const reputation = deriveSellerReputation([
    deal("completed", "completed"),
    deal("substrate", "failed-substrate"),
    deal("other", "aborted-by-other"),
  ], 0, 20);
  assert.equal(reputation.totalAgreements, 3);
  assert.equal(reputation.completionRate, 0.5);
  assert.equal(reputation.counterpartyAdjustedCompletionRate, 1);
  assert.equal(reputation.counterpartyFaultRate, 0.5);
  assert.equal(flipOutcome("failed-perm"), "failed-counterparty");
});

test("strict ref policy rejects unsigned referenced artifacts", async () => {
  const verification = result("completed", [
    { party: "buyer", verdict: "valid" },
    { party: "seller", verdict: "valid" },
  ]);
  verification.refs = [{ kind: "dacs-4-evidence", id: "e", verdict: "ok" }];
  assert.equal(await refsPassStrictPolicy(verification, [{
    kind: "dacs-4-evidence",
    raw: { evidenceVersion: "1", jobId: "j" },
  }]), false);
});

test("evidence ref must be signed by a bundle party", async () => {
  const evidenceScope = { evidenceVersion: "1", jobId: "j" };
  const message = Buffer.from(`dacs-evidence:v1:${contentHash(evidenceScope)}`, "utf8");
  const value = Buffer.from(await ed25519Sign(message, privateKeyFromSeed(seed))).toString("hex");
  const evidence = { ...evidenceScope, signatures: [{ algorithm: "ed25519", signer: did, value }] };

  const withParty = (partyClaim: string): BundleVerification => {
    const v = result("completed", [
      { party: "buyer", verdict: "valid" },
      { party: "seller", verdict: "valid" },
    ]);
    v.refs = [{ kind: "dacs-4-evidence", id: "e", verdict: "ok" }];
    v.bundle!.parties = [
      { role: "buyer", primaryClaim: partyClaim, bundleHash: "b" },
      { role: "seller", primaryClaim: "seller", bundleHash: "s" },
    ];
    return v;
  };

  // Signer is a party to the bundle → accepted.
  assert.equal(
    await refsPassStrictPolicy(withParty(did), [{ kind: "dacs-4-evidence", raw: evidence }]),
    true,
  );
  // Valid signature, but the signer is a stranger to the deal → rejected.
  assert.equal(
    await refsPassStrictPolicy(withParty(`did:demos:agent:${"9".repeat(64)}`), [
      { kind: "dacs-4-evidence", raw: evidence },
    ]),
    false,
  );
});

test("any valid revocation candidate wins and scanner candidates accumulate", async () => {
  const listingMessage = Buffer.from(`dacs-listing:v1:${contentHash(listing)}`, "utf8");
  const listingSignature = Buffer.from(
    await ed25519Sign(listingMessage, privateKeyFromSeed(seed)),
  ).toString("hex");
  const verified = await verifyListing({
    ...listing,
    signature: { algorithm: "ed25519", signer: did, value: listingSignature },
  });
  assert.ok(verified);
  if (!verified) return;

  const scope = {
    listingId: listing.listingId,
    listingVersion: listing.listingVersion,
    listingContentHash: verified.contentHash,
    revokedAt: Date.now(),
  };
  const message = Buffer.from(`dacs-revocation:v1:${contentHash(scope)}`, "utf8");
  const signature = Buffer.from(await ed25519Sign(message, privateKeyFromSeed(seed))).toString("hex");
  const valid = { ...scope, signature: { algorithm: "ed25519", signer: did, value: signature } };
  const bogus = { ...valid, revokedAt: scope.revokedAt + 1 };
  const records = new Map<string, Record<string, unknown>>([["bogus", bogus], ["valid", valid]]);
  const read = async (ref: string) => records.get(ref) ?? null;
  assert.equal(await hasValidListingRevocation(["bogus", "valid"], verified, 1, read), true);
  assert.equal(await hasValidListingRevocation(["bogus"], verified, 1, read), false);

  const candidates = new Map<string, string[]>();
  addRevocationCandidate(candidates, verified.contentHash, "stor-old");
  addRevocationCandidate(candidates, verified.contentHash, "stor-new");
  addRevocationCandidate(candidates, verified.contentHash, "stor-old");
  assert.deepEqual(candidates.get(verified.contentHash), ["stor-old", "stor-new"]);
});

test("public discovery excludes revoked listings and empty sellers", () => {
  const listingSummary = (status: "active" | "revoked") => ({
    listingId: status,
    version: 1,
    contentHash: status,
    anchor: { kind: "storage-program", locator: `stor-${status}` },
    seller: { primaryClaim: did, displayName: "Agent" },
    offering: { title: status, category: "services.test", tags: [] },
    pricing: {},
    status,
    catalogObservedAt: 1,
  });
  const seller = (listings: ReturnType<typeof listingSummary>[]): SellerRecord => ({
    primaryClaim: did,
    displayName: "Agent",
    cci: [],
    listings,
    deals: [],
    reputation: { completed: 0, totalAgreements: 0, completionRate: null },
    registeredAt: 1,
    lastIndexedAt: 1,
  });
  const catalog: Catalog = {
    catalogVersion: "1",
    generatedAt: 1,
    sellers: [seller([listingSummary("active"), listingSummary("revoked")]), seller([listingSummary("revoked")])],
  };
  assert.deepEqual(activeCatalogListings(catalog).map((entry) => entry.status), ["active"]);
  const activeSellers = activeCatalogSellers(catalog.sellers);
  assert.equal(activeSellers.length, 1);
  assert.deepEqual(activeSellers[0].listings.map((entry) => entry.status), ["active"]);
});

test("indexer rejects a shape-valid listing with a fake signature", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    success: true,
    owner: `0x${did.slice(-64)}`,
    programName: "dacs1:listing:test",
    data: { ...listing, signature: "deadbeef" },
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const record = await indexRegistration(
      { primaryClaim: did, displayName: "Victim", listingAnchors: [`stor-${"c".repeat(40)}`] },
      undefined,
      async () => { throw new Error("identity unavailable"); },
    );
    assert.equal(record.listings.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
