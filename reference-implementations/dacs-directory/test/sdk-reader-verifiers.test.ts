import assert from "node:assert/strict";
import test from "node:test";

import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { listingUpgradeReaderDeps, listingUpgradeRefusal } from "../src/catalog/listingUpgradeAcceptance.js";
import {
  sdkIdentityPresentationVerifier,
  sdkListingSignatureVerifier,
} from "../src/catalog/sdkReaderVerifiers.js";
import { validateListingArtifact } from "../src/sdkListingValidation.js";
import { signedRailSnapshot } from "./signed-rail-snapshot.js";

const seed = Uint8Array.from(Buffer.alloc(32, 31));
const privateKey = privateKeyFromSeed(seed);
const claim = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const otherClaim = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(Uint8Array.from(Buffer.alloc(32, 32))))).toString("hex")}`;
const sign = (message: string) =>
  Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKey)).toString("base64url");

const identityScope = { bundleVersion: "1", presentedBy: claim, presentedAt: 1, claims: [{ ref: claim }] };
const scope = {
  dacsVersion: "1",
  listingId: "reader-verifiers",
  listingVersion: 1,
  requiredCapabilities: ["SR-2"],
  seller: {
    identity: {
      ...identityScope,
      presentation: {
        kind: "per-claim",
        signatures: [{ ref: claim, signature: sign(`dacs-bundle-presentation:v1:${contentHash(identityScope)}`) }],
      },
    },
    displayName: "Reader verifier fixture",
  },
  offering: {
    title: "Reader verifier fixture",
    description: "Pins the deployment acceptance verifiers.",
    category: "services.test",
    tags: [],
    deliverable: { kind: "storage-program", accessModel: "public" },
  },
  buyerRequirement: { requirementVersion: "1", required: [], preferredPresentation: "any" },
  pipeline: [
    { kind: "negotiate-fixed-price" },
    { kind: "commit-agreement" },
    { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } },
    { kind: "deliver-storage-program" },
  ],
  pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } },
  acceptedRails: [{ railId: "demos-native:DEM" }],
  terms: {},
  validity: { notBefore: 1 },
};
const listing = {
  ...scope,
  signature: { algorithm: "ed25519" as const, signer: claim, value: sign(`dacs-listing:v1:${contentHash(scope)}`) },
};
const hexValue = Buffer.from(listing.signature.value, "base64url").toString("hex");

/** Exactly what `npm run check:listing-upgrade` passes to the SDK reader. */
const readerDeps = (inCodeDefinitions?: typeof signedRailSnapshot) => listingUpgradeReaderDeps({
  inCodeDefinitions,
  nowMs: () => 2,
  catalogObservedAt: 2,
  readMarker: async () => null,
  supportedPayloadMethods: [],
  signer: claim,
});

test("the acceptance check refuses a valid replacement while the PA-1 table is unsigned, as the publisher does", async () => {
  const result = await validateListingArtifact(listing, readerDeps()) as { disposition: string; step?: number; reason?: string };
  assert.equal(result.disposition, "indeterminate");
  assert.equal(result.step, 8);
  assert.equal(result.reason, "pa1-definition-unverifiable");
  assert.match(listingUpgradeRefusal(result) ?? "accepted", /unsigned, so no pay-bearing replacement is LP-6 verified/);
  assert.equal(listingUpgradeRefusal({ disposition: "verified" }), null);
  for (const disposition of ["rejected", "revoked", "indeterminate"]) {
    assert.match(listingUpgradeRefusal({ disposition, reason: "other" }) ?? "accepted", new RegExp(`returned ${disposition} \\(other\\)$`));
  }
});

test("acceptance verifiers verify SIG-6 values against the signer key, never by self-comparison", async () => {
  const verifyListingSignature = sdkListingSignatureVerifier();
  const signedBytes = Buffer.from(`dacs-listing:v1:${contentHash(scope)}`, "utf8");
  assert.equal(await verifyListingSignature({ signedBytes, signature: listing.signature }), true);
  assert.equal(await verifyListingSignature({ signedBytes, signature: { ...listing.signature, value: hexValue } }), false);
  assert.equal(await verifyListingSignature({ signedBytes, signature: { ...listing.signature, signer: otherClaim } }), false);
  assert.equal(await verifyListingSignature({
    signedBytes: Buffer.from(`dacs-listing:v1:${"0".repeat(64)}`, "utf8"),
    signature: listing.signature,
  }), false);

  const verifyIdentityPresentation = sdkIdentityPresentationVerifier();
  const bundle = scope.seller.identity as unknown as Parameters<typeof verifyIdentityPresentation>[0]["bundle"];
  const presentationBytes = Buffer.from(`dacs-bundle-presentation:v1:${contentHash(identityScope)}`, "utf8");
  assert.equal(await verifyIdentityPresentation({ bundle, signedBytes: presentationBytes }), true);
  assert.equal(await verifyIdentityPresentation({ bundle, signedBytes }), false);
});

test("with a signed PA-1 snapshot the acceptance reader verifies SIG-6 and rejects the same bytes as hex", async () => {
  assert.equal((await validateListingArtifact(listing, readerDeps(signedRailSnapshot))).disposition, "verified");
  const hexListing = { ...listing, signature: { ...listing.signature, value: hexValue } };
  const rejected = await validateListingArtifact(hexListing, readerDeps(signedRailSnapshot));
  assert.equal(rejected.disposition, "rejected");
  // Seller control is bound to the authenticated signer the script passes.
  const otherSigner = listingUpgradeReaderDeps({
    inCodeDefinitions: signedRailSnapshot, nowMs: () => 2, catalogObservedAt: 2, readMarker: async () => null, supportedPayloadMethods: [], signer: otherClaim,
  });
  assert.notEqual((await validateListingArtifact(listing, otherSigner)).disposition, "verified");

});

test("the identity presentation verifier accepts only per-claim presentations", async () => {
  const verifyIdentityPresentation = sdkIdentityPresentationVerifier();
  type Bundle = Parameters<typeof verifyIdentityPresentation>[0]["bundle"];
  const perClaim = scope.seller.identity as unknown as Bundle;
  const signedBytes = Buffer.from(`dacs-bundle-presentation:v1:${contentHash(identityScope)}`, "utf8");
  assert.equal(await verifyIdentityPresentation({ bundle: perClaim, signedBytes }), true);
  // The same valid per-claim signature carried under every other presentation kind.
  for (const kind of ["siwd", "session-key", "sr1-root"]) {
    const bundle = { ...perClaim, presentation: { ...perClaim.presentation, kind } } as unknown as Bundle;
    assert.equal(await verifyIdentityPresentation({ bundle, signedBytes }), false, kind);
  }
});
