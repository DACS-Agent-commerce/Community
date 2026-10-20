import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isListing } from "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash } from "@kynesyslabs/dacs/canonical";
import { identityBundleHash } from "@kynesyslabs/dacs/identity";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import {
  findValidListingRevocation,
  revocationLogicalAddress,
  verifyListing,
  verifyListingResult,
} from "../src/catalog/listingVerification.js";
import { sdkIdentityPresentationVerifier, sdkListingSignatureVerifier } from "../src/catalog/sdkReaderVerifiers.js";
import { checkListingRevocation } from "../vendor/dacs-sdk/dist/agent/listingValidation.js";

const seed = Uint8Array.from(Buffer.from("11".repeat(32), "hex"));
const privateKey = privateKeyFromSeed(seed);
const publicKeyHex = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex");
const claim = `did:demos:agent:${publicKeyHex}`;
const liveInvalidMethods = JSON.parse(readFileSync(
  new URL("./fixtures/live-invalid-verification-methods.json", import.meta.url),
  "utf8",
)) as Array<{
  listingId: string;
  listingVersion: number;
  locator: string;
  verificationMethod: string;
}>;

function signMessage(message: string): string {
  return Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKey)).toString("base64url");
}

function signedCurrentListing(
  extra: Record<string, unknown> = {},
  signingClaim = claim,
): Record<string, unknown> {
  const identity: Record<string, unknown> = {
    bundleVersion: "1",
    presentedBy: signingClaim,
    presentedAt: 1,
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

test("verifyListing applies the SDK shape gate to the exact signed bytes, including DID scheme case", async () => {
  const mixedCaseClaim = `DID:demos:agent:${publicKeyHex}`;
  const everyRole = signedCurrentListing({}, mixedCaseClaim);
  const lowercase = signedCurrentListing();
  // The signature envelope is outside the signed scope, so this value stays cryptographically valid.
  const signerOnly = {
    ...lowercase,
    signature: { ...(lowercase.signature as Record<string, unknown>), signer: mixedCaseClaim },
  };

  for (const listing of [everyRole, signerOnly]) {
    assert.equal(isListing(listing), false, "the pinned SDK reader rejects it at step 1");
    assert.deepEqual(await verifyListingResult(listing), { ok: false, code: "NORMATIVE_LISTING_INVALID" });
  }
  assert.equal((await verifyListing(lowercase))?.signer, claim);
});

test("a current Listing signature must be CORE §B.7 SIG-6 base64url, never raw hex", async () => {
  const listing = signedCurrentListing();
  const signature = listing.signature as Record<string, unknown> & { value: string };
  const hex = Buffer.from(signature.value, "base64url").toString("hex");
  const withValue = (value: string) => ({ ...listing, signature: { ...signature, value } });

  assert.equal(isListing(withValue(hex)), true, "128 hex characters are also valid base64url text");
  assert.deepEqual(await verifyListingResult(withValue(hex)), { ok: false, code: "LISTING_SIGNATURE_INVALID" });
  assert.deepEqual(await verifyListingResult(withValue(hex.toUpperCase())), { ok: false, code: "LISTING_SIGNATURE_INVALID" });
  assert.equal((await verifyListingResult(withValue(`0x${hex}`))).ok, false);
  assert.equal((await verifyListingResult(withValue(`${signature.value}==`))).ok, false);
  assert.equal((await verifyListingResult(listing)).ok, true);
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

test("live x402 string verification methods fail closed under the normative SDK validator", async () => {
  for (const fixture of liveInvalidMethods) {
    const listing = signedCurrentListing({
      listingId: fixture.listingId,
      listingVersion: fixture.listingVersion,
      offering: {
        title: fixture.listingId,
        description: `Regression fixture for ${fixture.locator}.`,
        category: "services.test",
        tags: ["x402"],
        deliverable: {
          kind: "attested-payload",
          payloadFormat: "application/json",
          verificationMethod: fixture.verificationMethod,
        },
      },
      pipeline: [
        { kind: "negotiate-fixed-price" },
        { kind: "commit-agreement" },
        { kind: "pay-x402", parameters: { rail: "pay-x402" } },
        { kind: "deliver-attested-payload" },
      ],
    });

    assert.equal(isListing(listing), false, fixture.listingId);
    assert.deepEqual(await verifyListingResult(listing), {
      ok: false,
      code: "VERIFICATION_METHOD_INVALID",
    });
    assert.equal(await verifyListing(listing), null);
  }

  const structured = signedCurrentListing({
    offering: {
      title: "Structured verification method",
      description: "A registered DACS-2 verification-method variant.",
      category: "services.test",
      tags: ["x402"],
      deliverable: {
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
      },
    },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-agreement" },
      { kind: "pay-x402", parameters: { rail: "pay-x402" } },
      { kind: "deliver-attested-payload" },
    ],
  });
  assert.equal(isListing(structured), true);
  assert.equal((await verifyListingResult(structured)).ok, true);
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
    pipeline: [{
      kind: "negotiate-rfq",
      parameters: { maxTurns: 2, timeoutSec: 60 },
    }, ...pipeline.slice(1)],
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

test("RB-2: a published revocation binding carries the exact presentedBy bytes an SDK reader compares", async () => {
  const presentedBy = `${claim}?channel=directory`;
  const listing = signedCurrentListing({}, presentedBy);
  const verified = await verifyListing(listing);
  assert.ok(verified);
  const scope = { listingId: "sig5-preserve-unknown", listingVersion: 1, listingContentHash: verified.contentHash, revokedAt: 1 };
  // RB-1: the marker signer repeats the listing signer exactly.
  const marker = { ...scope, signature: { algorithm: "ed25519", signer: presentedBy, value: signMessage(`dacs-revocation:v1:${contentHash(scope)}`) } };
  const binding = await findValidListingRevocation(["marker"], verified, 1, async () => marker);
  assert.ok(binding);
  assert.equal(binding.sellerPrimaryClaim, presentedBy);
  assert.equal(binding.logicalAddress, revocationLogicalAddress(presentedBy, "sig5-preserve-unknown", 1));
  const sdk = await checkListingRevocation(listing as never, verified.contentHash, {
    nowMs: () => 2,
    surfaces: [{ kind: "catalog", status: "revoked", catalogObservedAt: 2, binding }],
    readMarker: async () => marker,
    verifyMarkerSignature: sdkListingSignatureVerifier(),
  });
  assert.equal(sdk.disposition, "revoked", JSON.stringify(sdk));
});

test("the identity presentation signs the §6.3.2 bundle_hash, which keeps a top-level signature member", async () => {
  const listingWith = (presentationHash: (bundle: Record<string, unknown>) => string) => {
    const identity: Record<string, unknown> = {
      bundleVersion: "1",
      presentedBy: claim,
      presentedAt: 1,
      claims: [{ ref: claim, kind: "signing-key" }],
      signature: "bundle content, not a signature envelope",
    };
    identity.presentation = {
      kind: "per-claim",
      signatures: [{ ref: claim, signature: signMessage(`dacs-bundle-presentation:v1:${presentationHash(identity)}`) }],
    };
    const { signature: _signature, ...scope } = signedCurrentListing();
    const signedScope = { ...scope, seller: { ...(scope.seller as Record<string, unknown>), identity } };
    return {
      ...signedScope,
      signature: { algorithm: "ed25519", signer: claim, value: signMessage(`dacs-listing:v1:${contentHash(signedScope)}`) },
    };
  };
  assert.ok(await verifyListing(listingWith(identityBundleHash as never)), "SDK identityBundleHash");
  assert.equal(await verifyListing(listingWith(contentHash)), null, "contentHash strips the signature member");
});

test("admission reads the identity presentation: exact presentedBy entry, base64url or /register hex", async () => {
  // DACS-1 §6.3.2 and CORE §B.7 leave the per-claim signature's encoding open.
  // The pinned SDK reader reads base64url only; main's /register wrote the
  // wallet's 128 hex digits, so the Directory reads both, over the same bytes.
  const signatureBytes = (message: string) => Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKey));
  const otherKey = privateKeyFromSeed(Uint8Array.from(Buffer.alloc(32, 99)));
  const otherBytes = (message: string) => Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), otherKey));
  const cases: Record<string, [(message: string) => { ref: string; signature: string }, boolean, boolean]> = {
    "canonical base64url under the exact presentedBy": [(message) => ({ ref: claim, signature: signatureBytes(message).toString("base64url") }), true, true],
    "raw hex": [(message) => ({ ref: claim, signature: signatureBytes(message).toString("hex") }), false, true],
    "uppercase hex": [(message) => ({ ref: claim, signature: signatureBytes(message).toString("hex").toUpperCase() }), false, true],
    "base64url by another key": [(message) => ({ ref: claim, signature: otherBytes(message).toString("base64url") }), false, false],
    "raw hex by another key": [(message) => ({ ref: claim, signature: otherBytes(message).toString("hex") }), false, false],
    "raw hex over other bytes": [(message) => ({ ref: claim, signature: signatureBytes(`${message}0`).toString("hex") }), false, false],
    "0x-prefixed hex": [(message) => ({ ref: claim, signature: `0x${signatureBytes(message).toString("hex")}` }), false, false],
    "padded base64": [(message) => ({ ref: claim, signature: signatureBytes(message).toString("base64") }), false, false],
    // Same CF-3 identity, other bytes: SDK readers select the entry by exact `ref`.
    "presentedBy with an advisory parameter as the entry ref": [(message) => ({ ref: `${claim}?channel=directory`, signature: signatureBytes(message).toString("base64url") }), false, false],
  };
  for (const [label, [entry, sdkAccepted, accepted]] of Object.entries(cases)) {
    const identity: Record<string, unknown> = {
      bundleVersion: "1",
      presentedBy: claim,
      presentedAt: 1,
      claims: [{ ref: claim, kind: "signing-key" }],
    };
    const message = `dacs-bundle-presentation:v1:${identityBundleHash(identity as never)}`;
    identity.presentation = { kind: "per-claim", signatures: [entry(message)] };
    const { signature: _signature, ...scope } = signedCurrentListing();
    const signedScope = { ...scope, seller: { ...(scope.seller as Record<string, unknown>), identity } };
    const listing = {
      ...signedScope,
      signature: { algorithm: "ed25519", signer: claim, value: signMessage(`dacs-listing:v1:${contentHash(signedScope)}`) },
    };
    const sdkAccepts = await sdkIdentityPresentationVerifier()({
      bundle: identity as never,
      signedBytes: Buffer.from(message, "utf8"),
    });
    assert.equal(sdkAccepts, sdkAccepted, `SDK reader: ${label}`);
    const result = await verifyListingResult(listing);
    if (accepted) assert.equal(result.ok, true, label);
    else assert.deepEqual(result, { ok: false, code: "IDENTITY_PRESENTATION_INVALID" }, label);
  }
});


test("legacy Listing admission enforces the exact 16 KiB UTF-8 boundary", async () => {
  const scope = {
    agentId: claim, serviceId: "legacy-size", name: "Legacy size boundary", description: "",
    claimRequirements: [], supportedNegotiation: ["negotiate-fixed-price"], supportedPaymentRails: ["pay-dem"],
    supportedDelivery: ["deliver-attested-payload"],
  };
  const signed = (description: string) => {
    const body = { ...scope, description };
    return { ...body, signature: Buffer.from(ed25519Sign(Buffer.from(`dacs-listing:v1:${contentHash(body)}`, "utf8"), privateKey)).toString("hex") };
  };
  const overhead = Buffer.byteLength(JSON.stringify(signed("")), "utf8");
  const atLimit = signed("a".repeat(16_384 - overhead));
  const overLimit = signed("a".repeat(16_385 - overhead));
  assert.equal(Buffer.byteLength(JSON.stringify(atLimit), "utf8"), 16_384);
  assert.equal((await verifyListingResult(atLimit)).ok, true);
  assert.deepEqual(await verifyListingResult(overLimit), { ok: false, code: "LEGACY_LISTING_INVALID" });
  const multibyte = signed("é".repeat(Math.ceil((16_385 - overhead) / 2)));
  assert.ok(JSON.stringify(multibyte).length < 16_384);
  assert.deepEqual(await verifyListingResult(multibyte), { ok: false, code: "LEGACY_LISTING_INVALID" });
});

const RFQ = { maxTurns: 6, timeoutSec: 300 };
const sealed = (selectionRule: unknown, auctionMode?: string) => ({ commitDeadline: 1784016000000, revealWindow: 3600, selectionRule, ...(auctionMode ? { auctionMode } : {}) });
const negotiationStep = (kind: string, selectionRule: unknown = "lowest-price") => ({
  kind,
  ...(kind === "negotiate-rfq" ? { parameters: RFQ }
    : kind === "negotiate-sealed-envelope" ? { parameters: sealed(selectionRule) }
      : kind === "negotiate-sealed-envelope-procurement" ? { parameters: sealed(selectionRule, "procurement") } : {}),
});

test("PS-3: supported negotiation patterns enforce pricing compatibility; procurement remains unsupported", async () => {
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
    "negotiate-sealed-envelope-procurement": [],
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
  for (const rule of ["best-vibes", "", "rule-ref:not-a-hash:https://rules.example/r1", `rule-ref:${"a".repeat(64)}:`, [`lowest-price`], [`rule-ref:${"a".repeat(64)}:https://rules.example/r1`], `xrule-ref:${"a".repeat(64)}:https://rules.example/r1`, `rule-ref:${"a".repeat(64)}:https://rules.example/r1 `, 7]) {
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
    "buyer jurisdiction": { terms: { conflictOfLawsRule: "buyer-jurisdiction" } },
    "full ListingTerms": { terms: { termsOfServiceUrl: "https://t.example", termsOfServiceHash: "a".repeat(64), jurisdictions: ["GB", "US"],
      conflictOfLawsRule: "rule-ref:https://law.example", deadlineSecAfterCommit: 3600, acceptanceModel: "auto-accept", cancellationPolicy: "pre-commit",
      retentionYears: 7, transcriptDisclosurePolicy: "none", futureTerm: true } },
    "entitlement deliverable": { offering: offering({ kind: "entitlement", durationSec: 86_400, renewable: true }) },
    "attested-payload deliverable": { offering: offering({ kind: "attested-payload", payloadFormat: "application/json", verificationMethod: { kind: "self-signed" }, expectedSizeBytes: 10 }) },
    "encrypt-to-buyer storage": { offering: offering({ kind: "storage-program", accessModel: "encrypt-to-buyer" }) },
    "storage-program deliverable": { offering: offering({ kind: "storage-program", schemaUrl: "https://s.example", accessModel: "buyer-only" }) },
    "external deliverable": { offering: offering({ kind: "external", description: "Signed courier receipt", verificationMethod: { kind: "tlsnotary", endpoint: "https://n.example" } }) },
    "rate phase": { pipeline: [{ kind: "negotiate-fixed-price" }, ...tail, { kind: "rate", parameters: { required: true } }] },
    "rail with version": { acceptedRails: [{ railId: "pay-x402", railVersion: 2, parameters: { network: "base" } }] },
    "sealed-envelope demand": { pricing: auction, pipeline: [{ kind: "negotiate-sealed-envelope", parameters: { ...sealed("lowest-price"), auctionMode: "demand" } }, ...tail] },
    "rfq with fallback": { pricing: { kind: "negotiable", bandCenter: { amount: "1", currency: "USDC" }, minPct: 10, maxPct: 10 },
      pipeline: [{ kind: "negotiate-rfq", parameters: { ...RFQ, rfqInitiator: "seller", fixedPriceFallback: true } }, ...tail] },
    "notAfter after notBefore": { validity: { notBefore: 1, notAfter: 2 } },
    "required capabilities": { requiredCapabilities: ["SR-2", "SR-4"] },
  };
  const rejected: Record<string, Record<string, unknown>> = {
    "BundleRequirement without its version": { buyerRequirement: { required: [] } },
    "BundleRequirement without required": { buyerRequirement: { requirementVersion: "1" } },
    "ClaimRequirement array scheme": { buyerRequirement: { requirementVersion: "1", required: [{ scheme: ["lei"], verificationRequired: true }] } },
    "nested jurisdictions": { terms: { jurisdictions: [["US"]] } },
    "prefixed jurisdiction": { terms: { jurisdictions: ["XUS"] } },
    "suffixed jurisdiction": { terms: { jurisdictions: ["USX"] } },
    "unknown conflict rule": { terms: { conflictOfLawsRule: "xrule-ref:https://example.test" } },
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

const stripEnvelope = (listing: Record<string, unknown>): Record<string, unknown> => {
  const scope = { ...listing };
  delete scope.signature;
  return scope;
};

test("LR-2 caps the canonical form of the signed Listing at 16,384 bytes, as the SDK reader does, not the raw JSON", async () => {
  const canonicalBytes = (listing: Record<string, unknown>) => Buffer.byteLength(canonicalize(listing), "utf8");
  const sized = (bytes: number) => signedCurrentListing({
    padding: "x".repeat(bytes - canonicalBytes(signedCurrentListing({ padding: "" }))),
  });
  const atCap = sized(16_384);
  assert.equal(canonicalBytes(atCap), 16_384);
  assert.ok(await verifyListing(atCap));
  assert.equal(await verifyListing(sized(16_385)), null);
  // The signature envelope counts: an unsigned form at the cap is over it once signed.
  const unsignedAtCap = signedCurrentListing({ padding: "x".repeat(16_384 - canonicalBytes(stripEnvelope(signedCurrentListing({ padding: "" })))) });
  assert.equal(canonicalBytes(stripEnvelope(unsignedAtCap)), 16_384);
  assert.equal(await verifyListing(unsignedAtCap), null);
  // NFC composition shrinks the canonical form below the raw bytes; a composition exclusion grows it.
  const composing = signedCurrentListing({ padding: "é".repeat(5_000) });
  assert.ok(Buffer.byteLength(JSON.stringify(composing), "utf8") > 16_384);
  assert.ok(await verifyListing(composing));
  const expanding = signedCurrentListing({ padding: "क़".repeat(4_000) });
  assert.ok(Buffer.byteLength(JSON.stringify(expanding), "utf8") < 16_384);
  assert.equal(await verifyListing(expanding), null);
});

test("the indexer publishes a current listing at validity.notBefore, including a single-millisecond window (DACS-1 validation step 3)", async (t) => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const directory = mkdtempSync(join(tmpdir(), "dacs-directory-validity-"));
  process.env.DACS_DIRECTORY_DATA = directory;
  const { indexRegistration } = await import("../src/catalog/indexer.js");
  const anchors: Record<string, Record<string, unknown>> = {
    [`stor-${"a1".padStart(40, "0")}`]: signedCurrentListing({ listingId: "future", validity: { notBefore: Date.now() + 3_600_000 } }),
    [`stor-${"a2".padStart(40, "0")}`]: signedCurrentListing({ listingId: "current", validity: { notBefore: Date.now() - 1_000 } }),
    [`stor-${"a3".padStart(40, "0")}`]: signedCurrentListing({ listingId: "first-millisecond", validity: { notBefore: now, notAfter: now } }),
    [`stor-${"a4".padStart(40, "0")}`]: signedCurrentListing({ listingId: "one-millisecond-too-soon", validity: { notBefore: now + 1 } }),
    [`stor-${"a5".padStart(40, "0")}`]: signedCurrentListing({ listingId: "one-millisecond-too-late", validity: { notBefore: 1, notAfter: now - 1 } }),
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
    assert.deepEqual(record.listings.map((listing) => listing.listingId), ["current", "first-millisecond"]);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("negotiable bounds and metered units retain their independent schema types", async () => {
  const band = { kind: "negotiable", bandCenter: { amount: "1", currency: "USDC" }, minPct: 0, maxPct: 0 };
  const meter = { kind: "metered", unitPrice: { amount: "1", currency: "USDC" }, unit: "call" };
  assert.ok(await verifyListing(signedCurrentListing({ pricing: band })));
  assert.ok(await verifyListing(signedCurrentListing({ pricing: meter })));
  for (const pricing of [{ ...band, minPct: "0" }, { ...band, maxPct: "0" }, { ...band, minPct: -1 }, { ...band, minPct: 100 },
    { ...band, maxPct: -1 }, { ...meter, unit: ["call"] }, { ...meter, unit: 1 }, { ...meter, unit: "" }, { ...meter, unit: "x".repeat(65) }]) {
    assert.equal(await verifyListing(signedCurrentListing({ pricing })), null);
  }
});

test("shared canonicalization and listing verification reject lone surrogates in signed keys and values", async () => {
  const guarded = await import("../src/catalog/canonical.js");
  for (const surrogate of ["\ud800", "\udfff"]) {
    for (const extra of [{ nested: { value: surrogate } }, { nested: { [surrogate]: "value" } }]) {
      for (const canonical of [guarded.canonicalize, guarded.contentHash]) {
        assert.throws(() => canonical(extra), /invalid Unicode/);
      }
      // The pinned SDK cannot canonicalize, so cannot sign, these bytes; the Directory reader refuses them too.
      assert.throws(() => signedCurrentListing(extra), /not stable canonical JSON|surrogate/);
      const raw = { ...signedCurrentListing(), ...extra };
      assert.deepEqual(await verifyListingResult(raw), { ok: false, code: "NORMATIVE_LISTING_INVALID" });
    }
  }
  const valid = { nested: { ["\ud83d\ude00"]: "\ud83d\ude00" } };
  assert.doesNotThrow(() => guarded.canonicalize(valid));
  assert.equal(guarded.contentHash(valid), contentHash(valid));
  assert.ok(await verifyListing(signedCurrentListing(valid)));
});

test("independently signed storage-program listing accepts the explicit public access model", async () => {
  const { readFileSync } = await import("node:fs");
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/listing-public-storage.json", import.meta.url), "utf8"));
  const verified = await verifyListing(fixture.listing);
  assert.equal(verified?.contentHash, fixture.contentHash);
  assert.equal(verified?.profile, "dacs-v0.1");
  assert.equal(await verifyListing({ ...fixture.listing,
    offering: { ...fixture.listing.offering, deliverable: { kind: "storage-program", accessModel: "unknown" } },
  }), null);
});
