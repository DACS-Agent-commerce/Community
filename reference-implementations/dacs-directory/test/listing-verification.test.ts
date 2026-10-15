import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalize, contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { verifyListing } from "../src/catalog/listingVerification.js";

const seed = Uint8Array.from(Buffer.from("11".repeat(32), "hex"));
const privateKey = privateKeyFromSeed(seed);
const publicKeyHex = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex");
const claim = `did:demos:agent:${publicKeyHex}`;

function signMessage(message: string): string {
  return Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKey)).toString("base64url");
}

function signedCurrentListing(
  extra: Record<string, unknown> = {},
  signingClaim = claim,
): Record<string, unknown> {
  const identity: Record<string, unknown> = {
    presentedBy: signingClaim,
    claims: [{ ref: signingClaim, kind: "signing-key" }],
  };
  identity.presentation = {
    kind: "per-claim",
    signatures: [{
      ref: signingClaim,
      signature: signMessage(`dacs-bundle-presentation:v1:${contentHash(identity)}`),
    }],
  };

  const scope: Record<string, unknown> = {
    dacsVersion: "1",
    listingVersion: 1,
    listingId: "sig5-preserve-unknown",
    seller: {
      displayName: "SIG-5 Fixture Desk",
      identity,
    },
    offering: {
      title: "SIG-5 Fixture Desk",
      description: "Pins preserve-unknown behavior for Directory listing verification.",
      category: "conformance.signature",
      tags: ["sig5"],
      deliverable: { kind: "storage-program" },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-agreement" },
      { kind: "pay-x402", parameters: { rail: "pay-x402" } },
      { kind: "deliver-storage-program" },
    ],
    pricing: { kind: "fixed", price: { amount: "1", currency: "USDC" } },
    acceptedRails: [{ railId: "pay-x402", kind: "x402" }],
    terms: { refundPolicy: "none" },
    validity: { notBefore: 1784016000000 },
    ...extra,
  };

  return {
    ...scope,
    signature: {
      algorithm: "ed25519",
      signer: signingClaim,
      value: signMessage(`dacs-listing:v1:${contentHash(scope)}`),
    },
  };
}

test("verifyListing canonicalizes mixed-case DID scheme spelling on read", async () => {
  const mixedCaseClaim = `DID:demos:agent:${publicKeyHex}`;
  const verified = await verifyListing(signedCurrentListing({}, mixedCaseClaim));

  assert.equal(verified?.signer, claim);
  assert.equal(verified?.sellerClaim, claim);
});

test("verifyListing rejects suffix-shaped aliases even when their signatures are valid", async () => {
  for (const rejected of [
    `domain:${publicKeyHex}`,
    `demos:0x${publicKeyHex}`,
    `did:demos:agent:${publicKeyHex.toUpperCase()}`,
  ]) {
    assert.equal(await verifyListing(signedCurrentListing({}, rejected)), null, rejected);
  }
});

test("verifyListing preserves inert unknown top-level fields in the signed scope", async () => {
  const listing = signedCurrentListing({
    futureOptionalMetadata: { fixture: "preserve", color: "blue" },
  });
  const verified = await verifyListing(listing);

  assert.ok(verified);
  assert.equal(verified.profile, "dacs-v0.1");
  assert.equal(verified.contentHash, contentHash(verified.scope));
  assert.deepEqual(verified.scope.futureOptionalMetadata, { fixture: "preserve", color: "blue" });
});

test("verifyListing rejects mutation or removal of an unknown signed field", async () => {
  const listing = signedCurrentListing({
    futureOptionalMetadata: { fixture: "preserve", color: "blue" },
  });
  const mutated = structuredClone(listing);
  (mutated.futureOptionalMetadata as Record<string, unknown>).color = "red";
  const removed = structuredClone(listing);
  delete removed.futureOptionalMetadata;

  assert.equal(await verifyListing(mutated), null);
  assert.equal(await verifyListing(removed), null);
});

test("verifyListing refuses unknown executable phase kinds even with a valid signature", async () => {
  const listing = signedCurrentListing({
    pipeline: [{ kind: "negotiate-autonomous-barter" }],
  });

  assert.equal(await verifyListing(listing), null);
});

test("verifyListing requires exactly one adjacent supported commitment phase", async () => {
  const payeeBound = signedCurrentListing({
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-payee-bound-agreement" },
      { kind: "pay-x402", parameters: { rail: "pay-x402" } },
      { kind: "deliver-storage-program" },
    ],
  });
  assert.ok(await verifyListing(payeeBound));

  assert.equal(await verifyListing(signedCurrentListing({
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "pay-x402", parameters: { rail: "pay-x402" } },
      { kind: "deliver-storage-program" },
    ],
  })), null);
  assert.equal(await verifyListing(signedCurrentListing({
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-agreement" },
      { kind: "commit-payee-bound-agreement" },
      { kind: "pay-x402", parameters: { rail: "pay-x402" } },
      { kind: "deliver-storage-program" },
    ],
  })), null);
  assert.equal(await verifyListing(signedCurrentListing({
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "pay-x402", parameters: { rail: "pay-x402" } },
      { kind: "commit-payee-bound-agreement" },
      { kind: "deliver-storage-program" },
    ],
  })), null);
});

test("verifyListing accepts normative metered pricing bound to an AP2 rail", async () => {
  const metered = {
    kind: "metered",
    unitPrice: { amount: "0.02", currency: "USD" },
    unit: "API call",
    minTotal: { amount: "1", currency: "USD" },
  };
  const pipeline = [
    { kind: "negotiate-fixed-price" },
    { kind: "commit-agreement" },
    { kind: "pay-ap2", parameters: { rail: "ap2:stripe-paymentintents" } },
    { kind: "deliver-storage-program" },
  ];
  const listing = signedCurrentListing({
    pricing: metered,
    pipeline,
    acceptedRails: [{ railId: "ap2:stripe-paymentintents" }],
  });

  assert.ok(await verifyListing(listing));
  assert.ok(await verifyListing(signedCurrentListing({
    pricing: metered,
    pipeline: [{ kind: "negotiate-rfq", parameters: RFQ }, ...pipeline.slice(1)],
    acceptedRails: [{ railId: "ap2:stripe-paymentintents" }],
  })));
  assert.equal(await verifyListing(signedCurrentListing({
    pricing: { ...metered, minTotal: { amount: "1", currency: "EUR" } },
    pipeline,
    acceptedRails: [{ railId: "ap2:stripe-paymentintents" }],
  })), null);
  assert.equal(await verifyListing(signedCurrentListing({
    pricing: { ...metered, unit: "" },
    pipeline,
    acceptedRails: [{ railId: "ap2:stripe-paymentintents" }],
  })), null);
  assert.equal(await verifyListing(signedCurrentListing({
    pricing: metered,
    pipeline: [{ kind: "negotiate-sealed-envelope" }, ...pipeline.slice(1)],
    acceptedRails: [{ railId: "ap2:stripe-paymentintents" }],
  })), null);
});

const RFQ = { maxTurns: 6, timeoutSec: 300 };
const sealed = (selectionRule: unknown, auctionMode?: string) => ({ commitDeadline: 1784016000000, revealWindow: 3600, selectionRule, ...(auctionMode ? { auctionMode } : {}) });
const negotiationStep = (kind: string, selectionRule: unknown = "lowest-price") => ({
  kind,
  ...(kind === "negotiate-rfq" ? { parameters: RFQ }
    : kind === "negotiate-sealed-envelope" ? { parameters: sealed(selectionRule) }
      : kind === "negotiate-sealed-envelope-procurement" ? { parameters: sealed(selectionRule, "procurement") } : {}),
});

test("PS-3: each negotiation pattern accepts exactly the pricing kinds DACS-3 allows", async () => {
  const pricing: Record<string, Record<string, unknown>> = {
    fixed: { kind: "fixed", price: { amount: "1", currency: "USDC" } },
    negotiable: { kind: "negotiable", bandCenter: { amount: "1", currency: "USDC" }, minPct: 10, maxPct: 10 },
    auction: { kind: "auction", reservePrice: { amount: "1", currency: "USDC" }, selectionRule: "lowest-price" },
    metered: { kind: "metered", unitPrice: { amount: "1", currency: "USDC" }, unit: "call" },
  };
  const allowed: Record<string, string[]> = {
    "negotiate-fixed-price": ["fixed", "negotiable", "metered"],
    "negotiate-rfq": ["negotiable", "metered"],
    "negotiate-sealed-envelope": ["auction"],
    "negotiate-sealed-envelope-procurement": ["auction"],
  };
  const verdicts: Record<string, boolean> = {};
  const expected: Record<string, boolean> = {};
  for (const [negotiation, kinds] of Object.entries(allowed)) {
    for (const kind of Object.keys(pricing)) {
      const listing = signedCurrentListing({
        pricing: pricing[kind],
        pipeline: [negotiationStep(negotiation), { kind: "commit-agreement" }, { kind: "pay-x402", parameters: { rail: "pay-x402" } }, { kind: "deliver-storage-program" }],
      });
      verdicts[`${negotiation} ${kind}`] = (await verifyListing(listing)) !== null;
      expected[`${negotiation} ${kind}`] = kinds.includes(kind);
    }
  }
  assert.deepEqual(verdicts, expected);
});

test("auction pricing accepts only the DACS-4 selectionRule enum and content-hash-bound rule refs", async () => {
  const auction = (selectionRule: unknown) => signedCurrentListing({
    pricing: { kind: "auction", selectionRule },
    pipeline: [negotiationStep("negotiate-sealed-envelope", selectionRule), { kind: "commit-agreement" }, { kind: "pay-x402", parameters: { rail: "pay-x402" } }, { kind: "deliver-storage-program" }],
  });
  for (const rule of ["lowest-price", "highest-price", "first-acceptable", `rule-ref:${"a".repeat(64)}:https://rules.example/r1`]) {
    assert.ok(await verifyListing(auction(rule)), rule);
  }
  for (const rule of ["best-vibes", "", "rule-ref:not-a-hash:https://rules.example/r1", `rule-ref:${"a".repeat(64)}:`, 7]) {
    assert.equal(await verifyListing(auction(rule)), null, String(rule));
  }
});

test("schema conformance: recognised listing members must have their DACS-1/3/4 types (validation step 1)", async () => {
  const tail = [{ kind: "commit-agreement" }, { kind: "pay-x402", parameters: { rail: "pay-x402" } }, { kind: "deliver-storage-program" }];
  const auction = { kind: "auction", selectionRule: "lowest-price" };
  const offering = (deliverable: unknown) => ({ title: "T", description: "D", category: "conformance.signature", tags: [], deliverable });
  const accepted: Record<string, Record<string, unknown>> = {
    "full BundleRequirement": { buyerRequirement: { requirementVersion: "1", required: [{ scheme: "lei", verificationRequired: true, maxAge: 60, recipeVersion: 2, parameters: {} }],
      oneOf: [[{ scheme: "domain", verificationRequired: false }]], preferredPresentation: "per-claim", primaryClaimSelector: "lei" } },
    "full ListingTerms": { terms: { termsOfServiceUrl: "https://t.example", termsOfServiceHash: "a".repeat(64), jurisdictions: ["GB", "US"],
      conflictOfLawsRule: "rule-ref:https://law.example", deadlineSecAfterCommit: 3600, acceptanceModel: "auto-accept", cancellationPolicy: "pre-commit",
      retentionYears: 7, transcriptDisclosurePolicy: "none", futureTerm: true } },
    "entitlement deliverable": { offering: offering({ kind: "entitlement", durationSec: 86_400, renewable: true }) },
    "attested-payload deliverable": { offering: offering({ kind: "attested-payload", payloadFormat: "application/json", verificationMethod: { kind: "self-signed" }, expectedSizeBytes: 10 }) },
    "storage-program deliverable": { offering: offering({ kind: "storage-program", schemaUrl: "https://s.example", accessModel: "buyer-only" }) },
    "external deliverable": { offering: offering({ kind: "external", description: "Signed courier receipt", verificationMethod: { kind: "tlsnotary", endpoint: "https://n.example" } }) },
    "rate phase": { pipeline: [{ kind: "negotiate-fixed-price" }, ...tail, { kind: "rate", parameters: { required: true } }] },
    "rail with version": { acceptedRails: [{ railId: "pay-x402", railVersion: 2, parameters: { network: "base" } }] },
    "sealed-envelope demand": { pricing: auction, pipeline: [{ kind: "negotiate-sealed-envelope", parameters: { ...sealed("lowest-price"), auctionMode: "demand" } }, ...tail] },
    "sealed-envelope procurement": { pricing: auction, pipeline: [{ kind: "negotiate-sealed-envelope-procurement", parameters: sealed("lowest-price", "procurement") }, ...tail] },
    "rfq with fallback": { pricing: { kind: "negotiable", bandCenter: { amount: "1", currency: "USDC" }, minPct: 10, maxPct: 10 },
      pipeline: [{ kind: "negotiate-rfq", parameters: { ...RFQ, rfqInitiator: "seller", fixedPriceFallback: true } }, ...tail] },
    "notAfter after notBefore": { validity: { notBefore: 1, notAfter: 2 } },
    "required capabilities": { requiredCapabilities: ["SR-2", "SR-4"] },
  };
  const rejected: Record<string, Record<string, unknown>> = {
    "BundleRequirement without its version": { buyerRequirement: { required: [] } },
    "BundleRequirement without required": { buyerRequirement: { requirementVersion: "1" } },
    "ClaimRequirement without verificationRequired": { buyerRequirement: { requirementVersion: "1", required: [{ scheme: "lei" }] } },
    "empty oneOf group": { buyerRequirement: { requirementVersion: "1", required: [], oneOf: [[]] } },
    "unknown preferred presentation": { buyerRequirement: { requirementVersion: "1", required: [], preferredPresentation: "telepathy" } },
    "unknown cancellation policy": { terms: { cancellationPolicy: "non-refundable" } },
    "lowercase jurisdiction": { terms: { jurisdictions: ["gb"] } },
    "negative deadline": { terms: { deadlineSecAfterCommit: -1 } },
    "terms not an object": { terms: [] },
    "unknown deliverable kind": { offering: offering({ kind: "telegram" }) },
    "entitlement without renewable": { offering: offering({ kind: "entitlement", durationSec: 60 }) },
    "attested payload without format": { offering: offering({ kind: "attested-payload" }) },
    "external deliverable without description": { offering: offering({ kind: "external" }) },
    "unknown access model": { offering: offering({ kind: "storage-program", accessModel: "friends" }) },
    "rfq without parameters": { pricing: { kind: "negotiable", bandCenter: { amount: "1", currency: "USDC" }, minPct: 10, maxPct: 10 }, pipeline: [{ kind: "negotiate-rfq" }, ...tail] },
    "rfq with one turn": { pricing: { kind: "negotiable", bandCenter: { amount: "1", currency: "USDC" }, minPct: 10, maxPct: 10 }, pipeline: [{ kind: "negotiate-rfq", parameters: { ...RFQ, maxTurns: 1 } }, ...tail] },
    "sealed-envelope without parameters": { pricing: auction, pipeline: [{ kind: "negotiate-sealed-envelope" }, ...tail] },
    "sealed-envelope rules disagree": { pricing: auction, pipeline: [{ kind: "negotiate-sealed-envelope", parameters: sealed("highest-price") }, ...tail] },
    "sealed-envelope short reveal window": { pricing: auction, pipeline: [{ kind: "negotiate-sealed-envelope", parameters: { ...sealed("lowest-price"), revealWindow: 59 } }, ...tail] },
    "demand phase in procurement mode": { pricing: auction, pipeline: [{ kind: "negotiate-sealed-envelope", parameters: sealed("lowest-price", "procurement") }, ...tail] },
    "procurement without its mode": { pricing: auction, pipeline: [{ kind: "negotiate-sealed-envelope-procurement", parameters: sealed("lowest-price") }, ...tail] },
    "pipeline entry not an object": { pipeline: [{ kind: "negotiate-fixed-price" }, ...tail, "rate"] },
    "phase parameters not an object": { pipeline: [{ kind: "negotiate-fixed-price", parameters: [] }, ...tail] },
    "rate required not a boolean": { pipeline: [{ kind: "negotiate-fixed-price" }, ...tail, { kind: "rate", parameters: { required: "yes" } }] },
    "rail entry not an object": { acceptedRails: [{ railId: "pay-x402" }, "pay-dem"] },
    "rail without an id": { acceptedRails: [{ railId: "pay-x402" }, { railVersion: 1 }] },
    "notAfter not a number": { validity: { notBefore: 1, notAfter: "2999-01-01" } },
    "unknown capability": { requiredCapabilities: ["SR-9"] },
    "extended description hash not a string": { offering: { ...offering({ kind: "storage-program" }), extendedDescriptionHash: 7 } },
  };
  for (const [name, extra] of Object.entries(accepted)) assert.ok(await verifyListing(signedCurrentListing(extra)), name);
  for (const [name, extra] of Object.entries(rejected)) assert.equal(await verifyListing(signedCurrentListing(extra)), null, name);
});

test("LR-2 caps the canonical form at 16,384 bytes, signature omitted, not the raw JSON", async () => {
  const unsigned = (listing: Record<string, unknown>) => {
    const scope = { ...listing };
    delete scope.signature;
    return Buffer.byteLength(canonicalize(scope), "utf8");
  };
  const sized = (bytes: number) => signedCurrentListing({
    padding: "x".repeat(bytes - unsigned(signedCurrentListing({ padding: "" }))),
  });
  const atCap = sized(16_384);
  assert.equal(unsigned(atCap), 16_384);
  assert.ok(Buffer.byteLength(JSON.stringify(atCap), "utf8") > 16_384, "the raw JSON with its signature is larger");
  assert.ok(await verifyListing(atCap));
  assert.equal(await verifyListing(sized(16_385)), null);
  // NFC composition shrinks the canonical form below the raw bytes; a composition exclusion grows it.
  const composing = signedCurrentListing({ padding: "é".repeat(5_000) });
  assert.ok(Buffer.byteLength(JSON.stringify(composing), "utf8") > 16_384);
  assert.ok(await verifyListing(composing));
  const expanding = signedCurrentListing({ padding: "क़".repeat(4_000) });
  assert.ok(Buffer.byteLength(JSON.stringify(expanding), "utf8") < 16_384);
  assert.equal(await verifyListing(expanding), null);
});

test("the indexer publishes a current listing only once validity.notBefore has passed (DACS-1 validation step 3)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dacs-directory-validity-"));
  process.env.DACS_DIRECTORY_DATA = directory;
  const { indexRegistration } = await import("../src/catalog/indexer.js");
  const anchors: Record<string, Record<string, unknown>> = {
    [`stor-${"a1".padStart(40, "0")}`]: signedCurrentListing({ listingId: "future", validity: { notBefore: Date.now() + 3_600_000 } }),
    [`stor-${"a2".padStart(40, "0")}`]: signedCurrentListing({ listingId: "current", validity: { notBefore: Date.now() - 1_000 } }),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const data = anchors[String(input).split("/").pop() ?? ""];
    return data
      ? Response.json({ success: true, owner: `0x${publicKeyHex}`, programName: "opaque", data })
      : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
  };
  try {
    const record = await indexRegistration(
      { primaryClaim: claim, displayName: "Seller", listingAnchors: Object.keys(anchors) },
      undefined,
      async () => { throw new Error("identity unavailable"); },
    );
    assert.deepEqual(record.listings.map((listing) => listing.listingId), ["current"]);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});
