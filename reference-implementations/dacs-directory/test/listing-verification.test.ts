import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isListing } from "@kynesyslabs/dacs/artifacts";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { verifyListing, verifyListingResult } from "../src/catalog/listingVerification.js";

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
