import assert from "node:assert/strict";
import test from "node:test";

import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
} from "@kynesyslabs/dacs/crypto";

import {
  resolveDemosPrimaryClaimKey,
  resolvePrimaryClaimKey,
  verifyPrimaryClaimSignature,
  type ResolvePrimaryClaimKey,
} from "../src/catalog/primaryClaimKey.js";
import { registrationMessage, verifyOwnerSignature } from "../src/catalog/registrationSig.js";
import type { Registration } from "../src/catalog/types.js";

const seed = Uint8Array.from(Buffer.alloc(32, 41));
const privateKey = privateKeyFromSeed(seed);
const publicKey = rawPublicKey(publicKeyFromSeed(seed));
const publicKeyHex = Buffer.from(publicKey).toString("hex");
const canonicalClaim = `did:demos:agent:${publicKeyHex}`;

test("the default key resolver accepts only the registered Demos ClaimReference profile", async () => {
  const canonical = await resolveDemosPrimaryClaimKey(canonicalClaim, "ed25519");
  assert.equal(canonical?.canonicalClaim, canonicalClaim);
  assert.deepEqual(canonical?.publicKey, Uint8Array.from(publicKey));

  for (const readable of [
    `DID:demos:agent:${publicKeyHex}`,
    `DiD:demos:agent:${publicKeyHex}`,
  ]) {
    assert.equal((await resolveDemosPrimaryClaimKey(readable, "ed25519"))?.canonicalClaim, canonicalClaim);
  }

  for (const rejected of [
    `did:demos:agent:${publicKeyHex.toUpperCase()}`,
    `demos:0x${publicKeyHex}`,
    `0x${publicKeyHex}`,
    publicKeyHex,
    `domain:${publicKeyHex}`,
    `did:other:agent:${publicKeyHex}`,
  ]) {
    assert.equal(await resolveDemosPrimaryClaimKey(rejected, "ed25519"), null, rejected);
  }
  assert.equal(await resolveDemosPrimaryClaimKey(canonicalClaim, "secp256k1"), null);
});

test("an injected resolver enables a future scheme without weakening the default", async () => {
  const customClaim = "did:web:agent.example";
  const customResolver: ResolvePrimaryClaimKey = async (claim, algorithm) =>
    claim === customClaim && algorithm === "ed25519"
      ? { canonicalClaim: customClaim, algorithm, publicKey }
      : null;
  const message = Buffer.from("future ClaimReference resolver boundary", "utf8");
  const signature = await ed25519Sign(message, privateKey);

  assert.equal(await verifyPrimaryClaimSignature(
    message, signature, customClaim, "ed25519",
  ), null, "the default resolver must remain closed");
  assert.equal((await verifyPrimaryClaimSignature(
    message, signature, customClaim, "ed25519", customResolver,
  ))?.canonicalClaim, customClaim);

  const malformedKey: ResolvePrimaryClaimKey = async () => ({
    canonicalClaim: customClaim,
    algorithm: "ed25519",
    publicKey: new Uint8Array(31),
  });
  assert.equal(await resolvePrimaryClaimKey(customClaim, "ed25519", malformedKey), null);
});

test("registration owner verification rejects a valid signature from an unknown suffix-shaped claim", async () => {
  const registration: Registration = {
    primaryClaim: `domain:${publicKeyHex}`,
    displayName: "Unknown claim fixture",
    listingAnchors: [],
  };
  const signedAt = Date.now();
  const message = registrationMessage(registration, signedAt);
  registration.ownerSignature = {
    signedAt,
    message,
    signature: Buffer.from(await ed25519Sign(Buffer.from(message, "utf8"), privateKey)).toString("base64url"),
  };

  assert.equal(await verifyOwnerSignature(registration), false);
});
