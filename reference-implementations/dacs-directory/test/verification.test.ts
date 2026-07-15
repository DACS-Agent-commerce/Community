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
  bundleMatchesRegisteredAnchor,
  bundleMatchesRegisteredDeal,
  dedupeVerifiedDeals,
  hasRequiredBundleSignatures,
  registeredAnchorRole,
  refsPassStrictPolicy,
  verifyReferencedArtifactSignature,
  verifiedListingTerms,
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
const buyerSeed = Uint8Array.from(Buffer.alloc(32, 8));
const buyerDid = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(buyerSeed))).toString("hex")}`;

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
  assert.equal(await verifyListing({ ...signed, signatures: [null] }), null);
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
  const unsafeScope = { ...currentScope, seller: { ...currentScope.seller, publicEndpoint: "javascript:alert(1)" } };
  const unsafeValue = Buffer.from(await ed25519Sign(
    Buffer.from(`dacs-listing:v1:${contentHash(unsafeScope)}`, "utf8"),
    privateKeyFromSeed(seed),
  )).toString("hex");
  assert.equal(await verifyListing({ ...unsafeScope, signature: { algorithm: "ed25519", signer: did, value: unsafeValue } }), null);
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
      anchoredByRole: "buyer",
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

const rawBundleSignatures = (verification: BundleVerification, algorithm = "ed25519") =>
  verification.signatures.map((signature) => ({
    algorithm,
    party: signature.party,
    value: "cryptographically-verified-by-fixture",
  }));
const strictSigners = (verification: BundleVerification, raw: unknown = rawBundleSignatures(verification)) =>
  hasRequiredBundleSignatures(verification, { signatures: raw });

test("strict bundle signer policy rejects malformed roles and binds aborts to their anchor", () => {
  assert.equal(strictSigners(result("completed", [{ party: "buyer", verdict: "valid" }])), false);
  assert.equal(strictSigners(result("completed", [
    { party: "buyer", verdict: "valid" },
    { party: "seller", verdict: "valid" },
  ])), true);
  assert.equal(strictSigners(result("aborted-by-other", [{ party: "buyer", verdict: "valid" }])), true);
  assert.equal(strictSigners(result("aborted-by-self", [{ party: "buyer", verdict: "valid" }])), true);
  assert.equal(strictSigners(result("aborted-by-other", [{ party: "seller", verdict: "valid" }])), false);
  assert.equal(strictSigners(result("aborted-by-other", [
    { party: "buyer", verdict: "valid" },
    { party: "seller", verdict: "valid" },
  ])), true);
  assert.equal(strictSigners(result("banana", [
    { party: "buyer", verdict: "valid" },
    { party: "seller", verdict: "valid" },
  ])), false);

  const duplicateRole = result("completed", [
    { party: "buyer", verdict: "valid" },
    { party: "seller", verdict: "valid" },
  ]);
  duplicateRole.bundle!.parties.push({ role: "seller", primaryClaim: "other-seller", bundleHash: "o" });
  assert.equal(strictSigners(duplicateRole), false);

  const duplicateOrchestrator = result("completed", [
    { party: "buyer", verdict: "valid" },
    { party: "seller", verdict: "valid" },
    { party: "orchestrator-1", verdict: "valid" },
  ]);
  duplicateOrchestrator.bundle!.parties.push(
    { role: "orchestrator", primaryClaim: "orchestrator-1", bundleHash: "o1" },
    { role: "orchestrator", primaryClaim: "orchestrator-2", bundleHash: "o2" },
  );
  assert.equal(strictSigners(duplicateOrchestrator), false);

  const missingOrchestratorSignature = result("completed", [
    { party: "buyer", verdict: "valid" },
    { party: "seller", verdict: "valid" },
  ]);
  missingOrchestratorSignature.bundle!.parties.push(
    { role: "orchestrator", primaryClaim: "orchestrator", bundleHash: "o" },
  );
  assert.equal(strictSigners(missingOrchestratorSignature), false);
  const fullyOrchestrated = result("completed", [
    { party: "buyer", verdict: "valid" },
    { party: "seller", verdict: "valid" },
    { party: "orchestrator", verdict: "valid" },
  ]);
  fullyOrchestrated.bundle!.parties.push(
    { role: "orchestrator", primaryClaim: "orchestrator", bundleHash: "o" },
  );
  assert.equal(strictSigners(fullyOrchestrated), true);

  const buyerAlsoOrchestrates = result("completed", [
    { party: "buyer", verdict: "valid" },
    { party: "seller", verdict: "valid" },
  ]);
  buyerAlsoOrchestrates.bundle!.parties.push({ role: "orchestrator", primaryClaim: "buyer", bundleHash: "b" });
  assert.equal(strictSigners(buyerAlsoOrchestrates), true);

  const unknownRole = result("completed", [
    { party: "buyer", verdict: "valid" },
    { party: "seller", verdict: "valid" },
  ]);
  unknownRole.bundle!.parties.push({ role: "auditor", primaryClaim: "auditor", bundleHash: "a" });
  assert.equal(strictSigners(unknownRole), false);

  const key = "a".repeat(64);
  const sameIdentity = result("completed", [
    { party: `did:demos:agent:${key}`, verdict: "valid" },
    { party: `0x${key.toUpperCase()}`, verdict: "valid" },
  ]);
  sameIdentity.bundle!.parties = [
    { role: "buyer", primaryClaim: `did:demos:agent:${key}`, bundleHash: "b" },
    { role: "seller", primaryClaim: `0x${key.toUpperCase()}`, bundleHash: "s" },
  ];
  assert.equal(strictSigners(sameIdentity), false);

  const valid = result("completed", [
    { party: "buyer", verdict: "valid" },
    { party: "seller", verdict: "valid" },
  ]);
  assert.equal(strictSigners(valid, rawBundleSignatures(valid, "ecdsa-secp256k1")), false);
  assert.equal(strictSigners(valid, [...rawBundleSignatures(valid), null]), false);
  assert.equal(hasRequiredBundleSignatures(valid, {
    signatures: rawBundleSignatures(valid),
    signature: null,
  }), false);
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
  const key = "a".repeat(64);
  verification.bundle!.parties = [
    { role: "buyer", primaryClaim: `did:demos:agent:${key}`, bundleHash: "b" },
    { role: "seller", primaryClaim: `0x${key}`, bundleHash: "s" },
  ];
  assert.equal(bundleMatchesRegisteredDeal(verification.bundle, {
    ...deal,
    owners: { buyer: `did:demos:agent:${key}`, seller: `0x${key}` },
  }, `0x${key}`), false);
});

test("unhashed anchor role must match the registered copy address", () => {
  const verification = result("completed", [
    { party: "buyer", verdict: "valid" },
    { party: "seller", verdict: "valid" },
  ]);
  assert.equal(bundleMatchesRegisteredAnchor(
    verification.bundle, "stor-buyer", "stor-buyer", "stor-seller",
  ), true);
  verification.bundle!.anchoredByRole = "seller";
  assert.equal(bundleMatchesRegisteredAnchor(
    verification.bundle, "stor-buyer", "stor-buyer", "stor-seller",
  ), false);
  assert.equal(bundleMatchesRegisteredAnchor(
    verification.bundle, "stor-unknown", "stor-buyer", "stor-seller",
  ), false);
  assert.equal(registeredAnchorRole("stor-seller", "stor-buyer", undefined), null);
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

test("strict ref policy binds positional kinds, hashes, and unique references", async () => {
  const signature = async (prefix: string, scope: Record<string, unknown>, signer: string, signingSeed: Uint8Array) => ({
    algorithm: "ed25519",
    signer,
    value: Buffer.from(await ed25519Sign(
      Buffer.from(`${prefix}${contentHash(scope)}`, "utf8"),
      privateKeyFromSeed(signingSeed),
    )).toString("hex"),
  });
  const agreementScope = { jobId: "j", buyer: buyerDid, seller: did };
  const agreement = {
    ...agreementScope,
    signatures: [
      await signature("dacs-agreement:v1:", agreementScope, buyerDid, buyerSeed),
      await signature("dacs-agreement:v1:", agreementScope, did, seed),
    ],
  };
  const evidenceScope = { evidenceVersion: "1", jobId: "j" };
  const evidence = {
    ...evidenceScope,
    signature: await signature("dacs-evidence:v1:", evidenceScope, did, seed),
  };
  const signedListing = {
    ...listing,
    signature: await signature("dacs-listing:v1:", listing, did, seed),
  };
  const verification = result("completed", [
    { party: buyerDid, verdict: "valid" },
    { party: did, verdict: "valid" },
  ]);
  verification.bundle!.parties = [
    { role: "buyer", primaryClaim: buyerDid, bundleHash: "b" },
    { role: "seller", primaryClaim: did, bundleHash: "s" },
  ];
  verification.bundle!.agreementRef = {
    kind: "dacs-3-agreement", id: "agreement-j", contentHash: contentHash(agreementScope),
  };
  verification.bundle!.settlementEvidence = [{
    kind: "dacs-4-evidence", id: "evidence-j", contentHash: contentHash(evidenceScope),
  }];
  verification.bundle!.phaseSummary = [{
    index: 0,
    kind: "settle",
    outcome: "ok",
    attestationRef: verification.bundle!.settlementEvidence[0],
  }];
  verification.bundle!.listingRef.contentHash = contentHash(listing);
  verification.refs = [
    { kind: "dacs-3-agreement", id: "agreement-j", verdict: "ok" },
    { kind: "dacs-4-evidence", id: "evidence-j", verdict: "ok" },
    { kind: "dacs-1-listing", id: "svc", verdict: "ok" },
  ];
  const artifacts = [
    { kind: "dacs-3-agreement", raw: agreement },
    { kind: "dacs-4-evidence", raw: evidence },
    { kind: "dacs-1-listing", raw: signedListing },
  ];
  assert.equal(await refsPassStrictPolicy(verification, artifacts), true);

  const substituted = structuredClone(verification);
  substituted.bundle!.agreementRef.kind = "dacs-2-verifyresult";
  substituted.refs[0].kind = "dacs-2-verifyresult";
  assert.equal(await refsPassStrictPolicy(substituted, [
    { ...artifacts[0], kind: "dacs-2-verifyresult" },
    ...artifacts.slice(1),
  ]), false);

  const duplicated = structuredClone(verification);
  duplicated.bundle!.settlementEvidence.push({
    kind: "dacs-4-evidence", id: "evidence-j-copy", contentHash: contentHash(evidenceScope),
  });
  duplicated.refs.splice(2, 0, { kind: "dacs-4-evidence", id: "evidence-j-copy", verdict: "ok" });
  assert.equal(await refsPassStrictPolicy(duplicated, [
    artifacts[0], artifacts[1], artifacts[1], artifacts[2],
  ]), false);

  const unsupported = structuredClone(verification) as BundleVerification & {
    bundle: NonNullable<BundleVerification["bundle"]> & { ratingRefs: unknown[] };
  };
  unsupported.bundle.ratingRefs = [{ kind: "dacs-5-rating", id: "rating-j", contentHash: "f".repeat(64) }];
  assert.equal(await refsPassStrictPolicy(unsupported, artifacts), false);

  const orphanedPhaseRef = structuredClone(verification);
  orphanedPhaseRef.bundle!.phaseSummary[0].attestationRef = {
    kind: "dacs-4-evidence", id: "unverified-evidence", contentHash: "e".repeat(64),
  };
  assert.equal(await refsPassStrictPolicy(orphanedPhaseRef, artifacts), false);

  const optionalPhaseRef = structuredClone(verification);
  delete (optionalPhaseRef.bundle!.phaseSummary[0] as unknown as Record<string, unknown>).attestationRef;
  assert.equal(await refsPassStrictPolicy(optionalPhaseRef, artifacts), true);

  const crossJob = structuredClone(verification);
  crossJob.bundle!.jobId = "another-job";
  assert.equal(await refsPassStrictPolicy(crossJob, artifacts), false);

  const crossParty = structuredClone(verification);
  crossParty.bundle!.parties[0].primaryClaim = `did:demos:agent:${"9".repeat(64)}`;
  assert.equal(await refsPassStrictPolicy(crossParty, artifacts), false);
});

test("strict ref policy rejects unsigned referenced artifacts", async () => {
  assert.equal(await verifyReferencedArtifactSignature({
    kind: "dacs-4-evidence",
    raw: { evidenceVersion: "1", jobId: "j" },
  }, new Set(["buyer", "seller"])), false);
  assert.equal(await verifyReferencedArtifactSignature({
    kind: "dacs-4-evidence",
    raw: {
      evidenceVersion: "1",
      jobId: "j",
      signature: { algorithm: "ed25519", signer: "buyer", value: "not-reached" },
      signatures: [null],
    },
  }, new Set(["buyer", "seller"])), false);
});

test("legacy cancellation terms come only from the exact hash/version-pinned listing", () => {
  const pinnedScope = {
    ...listing,
    terms: { cancellationPolicy: "pre-commit" },
  };
  const verification = result("aborted-by-self", [
    { party: "buyer", verdict: "valid" },
    { party: "seller", verdict: "valid" },
  ]);
  verification.bundle!.listingRef = {
    listingId: "svc",
    version: 1,
    contentHash: contentHash(pinnedScope),
  };
  const pinnedArtifact = {
    kind: "dacs-1-listing",
    raw: { ...pinnedScope, signature: "verified-by-strict-policy" },
  };
  assert.deepEqual(
    verifiedListingTerms(verification, [pinnedArtifact], true),
    { cancellationPolicy: "pre-commit" },
  );

  const laterVersion = {
    ...pinnedScope,
    listingVersion: 2,
    terms: { cancellationPolicy: "non-refundable" },
    signature: "verified-by-strict-policy",
  };
  assert.equal(verifiedListingTerms(verification, [{ kind: "dacs-1-listing", raw: laterVersion }], true), undefined);
  assert.equal(verifiedListingTerms(verification, [pinnedArtifact], false), undefined);
});

test("evidence ref must be signed by a bundle party", async () => {
  const evidenceScope = { evidenceVersion: "1", jobId: "j" };
  const message = Buffer.from(`dacs-evidence:v1:${contentHash(evidenceScope)}`, "utf8");
  const value = Buffer.from(await ed25519Sign(message, privateKeyFromSeed(seed))).toString("hex");
  const evidence = { ...evidenceScope, signatures: [{ algorithm: "ed25519", signer: did, value }] };

  // Signer is a party to the bundle → accepted.
  assert.equal(
    await verifyReferencedArtifactSignature({ kind: "dacs-4-evidence", raw: evidence }, new Set([did, "seller"])),
    true,
  );
  // Valid signature, but the signer is a stranger to the deal → rejected.
  assert.equal(
    await verifyReferencedArtifactSignature({ kind: "dacs-4-evidence", raw: evidence },
      new Set([`did:demos:agent:${"9".repeat(64)}`, "seller"])),
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

test("listing verification is open-world: an unknown additive top-level field is accepted (SIG-5 / §11.1.2 additivity, older-reads-newer)", async () => {
  const identityScope = {
    bundleVersion: "1", presentedBy: did, presentedAt: 1, claims: [{ ref: did }],
  };
  const identitySignature = Buffer.from(await ed25519Sign(
    Buffer.from(`dacs-bundle-presentation:v1:${contentHash(identityScope)}`, "utf8"),
    privateKeyFromSeed(seed),
  )).toString("hex");
  const baseScope = {
    dacsVersion: "1", listingVersion: 1, listingId: "svc", requiredCapabilities: ["SR-2"],
    seller: {
      identity: { ...identityScope, presentation: { kind: "per-claim", signatures: [{ ref: did, signature: identitySignature }] } },
      displayName: "Service agent", publicEndpoint: "https://agent.example/a2a",
    },
    offering: { title: "Service", description: "Description", category: "services.test", tags: ["test"], deliverable: { kind: "attested-payload", payloadFormat: "application/json" } },
    buyerRequirement: { requirementVersion: "1", required: [], preferredPresentation: "any" },
    pipeline: [
      { kind: "negotiate-fixed-price" }, { kind: "commit-agreement" },
      { kind: "pay-dem", parameters: { rail: "pay-dem" } }, { kind: "deliver-attested-payload" },
    ],
    pricing: { kind: "fixed", price: { amount: "1", currency: "DEM", unit: "per-job" } },
    acceptedRails: [{ railId: "pay-dem" }], terms: {}, validity: { notBefore: 1 },
  };
  // A field a FUTURE spec minor might add at the top level (unknown to this reader).
  const forwardScope = { ...baseScope, futureListingField: { addedInMinor: "0.3", note: "reader must tolerate" } };

  // (1) Accept: the unknown field is part of the signed scope (contentHash covers the whole object),
  // so the signature verifies and the listing is accepted as the dacs-v0.1 profile. A closed
  // top-level allowlist would (wrongly) reject this.
  const acceptValue = Buffer.from(await ed25519Sign(
    Buffer.from(`dacs-listing:v1:${contentHash(forwardScope)}`, "utf8"), privateKeyFromSeed(seed),
  )).toString("hex");
  const accepted = await verifyListing({ ...forwardScope, signature: { algorithm: "ed25519", signer: did, value: acceptValue } });
  assert.ok(accepted, "unknown additive top-level field must be tolerated (open-world)");
  assert.equal(accepted?.profile, "dacs-v0.1");

  // (2) Bind: an unknown field INJECTED AFTER signing (signature computed over baseScope,
  // field bolted on afterward) MUST be rejected — the whole-scope hash catches it. This proves the
  // open-world relaxation did NOT weaken signature binding.
  const baseValue = Buffer.from(await ed25519Sign(
    Buffer.from(`dacs-listing:v1:${contentHash(baseScope)}`, "utf8"), privateKeyFromSeed(seed),
  )).toString("hex");
  const injected = { ...baseScope, futureListingField: { evil: true }, signature: { algorithm: "ed25519", signer: did, value: baseValue } };
  assert.equal(await verifyListing(injected), null, "field injected after signing must fail the whole-scope hash");
});

test("DACS-5 determinism receipt orders arrays by byte order, not locale collation (§10.5.3(2))", () => {
  const deal = (jobId: string): DealRecord => ({
    jobId, rail: "pay-dem", buyerBundleRef: `stor-${jobId.padEnd(40, "a")}`,
    owners: { buyer: "buyer", seller: "seller" }, signatureVerified: true, refsVerified: true,
    reputationEligible: true, sellerOutcome: "completed", finalisedAt: 10, verifiedAt: 10,
    bundleContentHash: jobId.padEnd(64, "b"), agreementPrice: { amount: "1", currency: jobId[0] },
  });
  // 'Z' (0x5A) sorts BEFORE 'a' (0x61) in byte order, but AFTER it under typical ICU locale
  // collation — so this input distinguishes the specified comparator (byte-order, §10.5.3(2))
  // from `localeCompare`. Under the old comparator, bundleRefs[0] would start with 'a'.
  const rep = deriveSellerReputation([deal("Zjob"), deal("ajob")], 0, 20);
  assert.ok(rep.bundleRefs);
  assert.equal(rep.bundleRefs[0].contentHash[0], "Z");
  assert.equal(rep.bundleRefs[1].contentHash[0], "a");
  assert.deepEqual(rep.observedTransactionalVolume?.map(({ currency }) => currency), ["Z", "a"]);
  assert.deepEqual(rep.transactionCountByCurrency?.map(({ currency }) => currency), ["Z", "a"]);
});
