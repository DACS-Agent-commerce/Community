import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isListing } from "@kynesyslabs/dacs/artifacts";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { identityBundleHash } from "@kynesyslabs/dacs/identity";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import {
  findValidListingRevocation,
  revocationLogicalAddress,
  verifyListing,
  verifyListingResult,
} from "../src/catalog/listingVerification.js";
import { sdkListingSignatureVerifier } from "../src/catalog/sdkReaderVerifiers.js";
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
