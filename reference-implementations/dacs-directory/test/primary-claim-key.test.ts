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
  sameResolvedPrimaryClaim,
  verifyPrimaryClaimSignature,
  verifyResolvedPrimaryClaimSignature,
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

test("every malformed field of an injected resolver result is refused on its own", async () => {
  const valid = { canonicalClaim, algorithm: "ed25519" as const, publicKey: Uint8Array.from(publicKey) };
  const resolverFor = (result: unknown): ResolvePrimaryClaimKey => async () => result as never;
  assert.deepEqual(await resolvePrimaryClaimKey(canonicalClaim, "ed25519", resolverFor(valid)), valid);
  const cases: Record<string, [unknown, unknown, unknown]> = {
    "non-string claim": [7, "ed25519", valid],
    "non-string algorithm": [canonicalClaim, 7, valid],
    "null result": [canonicalClaim, "ed25519", null],
    "non-ed25519 result": [canonicalClaim, "ed25519", { ...valid, algorithm: "secp256k1" }],
    "result algorithm differs from the request": [canonicalClaim, "ecdsa-secp256k1", valid],
    "non-string canonicalClaim": [canonicalClaim, "ed25519", { ...valid, canonicalClaim: 7 }],
    "empty canonicalClaim": [canonicalClaim, "ed25519", { ...valid, canonicalClaim: "" }],
    "array key": [canonicalClaim, "ed25519", { ...valid, publicKey: Array.from(publicKey) }],
    "31-byte key": [canonicalClaim, "ed25519", { ...valid, publicKey: new Uint8Array(31) }],
    "33-byte key": [canonicalClaim, "ed25519", { ...valid, publicKey: new Uint8Array(33) }],
  };
  for (const [name, [claim, algorithm, result]] of Object.entries(cases)) {
    assert.equal(await resolvePrimaryClaimKey(claim, algorithm, resolverFor(result)), null, name);
  }
  const throwing: ResolvePrimaryClaimKey = async () => { throw new Error("resolver offline"); };
  assert.equal(await resolvePrimaryClaimKey(canonicalClaim, "ed25519", throwing), null);
});

test("signature verification fails closed on crypto exceptions", async () => {
  const message = Buffer.from("crypto exception boundary", "utf8");
  const signature = await ed25519Sign(message, privateKey);
  const resolved = { canonicalClaim, algorithm: "ed25519" as const, publicKey: Uint8Array.from(publicKey) };
  assert.equal(verifyResolvedPrimaryClaimSignature(message, signature, resolved), true);
  assert.equal(verifyResolvedPrimaryClaimSignature(message, signature, { ...resolved, publicKey: new Uint8Array(31) }), false);
  assert.equal(verifyResolvedPrimaryClaimSignature(message, signature.slice(0, 63), resolved), false);
});

test("two resolved identities are the same only when every field matches", () => {
  const left = { canonicalClaim, algorithm: "ed25519" as const, publicKey: Uint8Array.from(publicKey) };
  assert.equal(sameResolvedPrimaryClaim(left, { ...left, publicKey: Uint8Array.from(publicKey) }), true);
  const flipped = Uint8Array.from(publicKey);
  flipped[31] ^= 1;
  const differing: Record<string, typeof left> = {
    algorithm: { ...left, algorithm: "ecdsa-secp256k1" as never },
    canonicalClaim: { ...left, canonicalClaim: `did:demos:agent:${"0".repeat(64)}` },
    "key length": { ...left, publicKey: Uint8Array.from([...publicKey, 0]) },
    "key bytes": { ...left, publicKey: flipped },
  };
  for (const [name, right] of Object.entries(differing)) {
    assert.equal(sameResolvedPrimaryClaim(left, right), false, name);
    assert.equal(sameResolvedPrimaryClaim(right, left), false, `${name} (reversed)`);
  }
});
