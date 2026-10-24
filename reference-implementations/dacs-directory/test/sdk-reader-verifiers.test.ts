import assert from "node:assert/strict";
import test from "node:test";

import type { IdentityBundle } from "@kynesyslabs/dacs/artifacts";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { sdkIdentityPresentationVerifier, sdkListingSignatureVerifier } from "../src/catalog/sdkReaderVerifiers.js";

const seed = Uint8Array.from(Buffer.alloc(32, 0x21));
const privateKey = privateKeyFromSeed(seed);
const claim = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const qualifiedClaim = `${claim}?channel=directory`;
const stranger = `did:demos:agent:${"ab".repeat(32)}`;
const signedBytes = Uint8Array.from(Buffer.from("signed bytes under test"));
const sign = (bytes: Uint8Array) => Buffer.from(ed25519Sign(bytes, privateKey));
const signature = sign(signedBytes);
const signatureOverOtherBytes = sign(Uint8Array.from(Buffer.from("other bytes")));
const outage = new Error("resolver offline");
const offlineResolver = async () => { throw outage; };

const listingSignature = (value: string, signer = claim) => ({ algorithm: "ed25519" as const, signer, value });

function bundleWith(presentedBy: string, entries: Array<{ ref: string; signature: string }>): IdentityBundle {
  return {
    bundleVersion: "1", presentedBy, presentedAt: 1, claims: [{ ref: presentedBy }],
    presentation: { kind: "per-claim", signatures: entries },
  } as IdentityBundle;
}

test("the listing verifier accepts the canonical Base64URL signature", async () => {
  const verify = sdkListingSignatureVerifier();
  assert.equal(await verify({ signedBytes, signature: listingSignature(signature.toString("base64url")) }), true);
});

test("the listing verifier refuses hex, padded and truncated signature spellings", async () => {
  const verify = sdkListingSignatureVerifier();
  for (const value of [signature.toString("hex"), signature.toString("base64"), signature.toString("base64url").slice(0, -4)]) {
    assert.equal(await verify({ signedBytes, signature: listingSignature(value) }), false, value);
  }
});

test("the listing verifier refuses a signature over other bytes", async () => {
  const verify = sdkListingSignatureVerifier();
  const value = signatureOverOtherBytes.toString("base64url");
  assert.equal(await verify({ signedBytes, signature: listingSignature(value) }), false);
});

test("the listing verifier refuses a signer that is not the signing key", async () => {
  const verify = sdkListingSignatureVerifier();
  assert.equal(await verify({ signedBytes, signature: listingSignature(signature.toString("base64url"), stranger) }), false);
});

test("the listing verifier throws when the key resolver fails, so the SDK reader stays indeterminate", async () => {
  const verify = sdkListingSignatureVerifier(offlineResolver);
  await assert.rejects(verify({ signedBytes, signature: listingSignature(signature.toString("base64url")) }), outage);
});

test("the presentation verifier accepts hex, Base64URL and padded Base64 signatures", async () => {
  const verify = sdkIdentityPresentationVerifier();
  for (const value of [signature.toString("hex"), signature.toString("base64url"), signature.toString("base64")]) {
    assert.equal(await verify({ bundle: bundleWith(claim, [{ ref: claim, signature: value }]), signedBytes }), true, value);
  }
});

test("the presentation verifier refuses malformed and foreign signature values", async () => {
  const verify = sdkIdentityPresentationVerifier();
  for (const value of [`0x${signature.toString("hex")}`, signature.toString("hex").slice(2), signatureOverOtherBytes.toString("base64url")]) {
    assert.equal(await verify({ bundle: bundleWith(claim, [{ ref: claim, signature: value }]), signedBytes }), false, value);
  }
});

test("the presentation verifier refuses a presentation that is not per-claim", async () => {
  const verify = sdkIdentityPresentationVerifier();
  const bundle = {
    ...bundleWith(claim, []),
    presentation: { kind: "session-key", key: claim, signature: signature.toString("base64url") },
  } as IdentityBundle;
  assert.equal(await verify({ bundle, signedBytes }), false);
});

test("the presentation verifier refuses when no entry is for the presenting claim", async () => {
  const verify = sdkIdentityPresentationVerifier();
  const bundle = bundleWith(claim, [{ ref: stranger, signature: signature.toString("base64url") }]);
  assert.equal(await verify({ bundle, signedBytes }), false);
});

test("the presentation verifier matches the entry to the presenting claim by CF-3 identity", async () => {
  const verify = sdkIdentityPresentationVerifier();
  const value = signature.toString("base64url");
  for (const [presentedBy, ref] of [[qualifiedClaim, claim], [claim, qualifiedClaim], [qualifiedClaim, qualifiedClaim]]) {
    assert.equal(await verify({ bundle: bundleWith(presentedBy, [{ ref, signature: value }]), signedBytes }), true, `${presentedBy} / ${ref}`);
  }
});

test("the presentation verifier throws when the key resolver fails, so the SDK reader stays indeterminate", async () => {
  const verify = sdkIdentityPresentationVerifier(offlineResolver);
  const bundle = bundleWith(claim, [{ ref: claim, signature: signature.toString("base64url") }]);
  await assert.rejects(verify({ bundle, signedBytes }), outage);
});
