import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { dacsXSeparator, ed25519Sign, ed25519Verify, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import { verifySignedArtifact } from "../src/sdkVerification.js";

test("historical delivery attestations retain NFC member-name hashing and reject changed signed bytes", async () => {
  const seed = new Uint8Array(32).fill(27);
  const key = rawPublicKey(publicKeyFromSeed(seed));
  const separator = dacsXSeparator("delivery-attestation") as never;
  const verify = (bytes: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) =>
    ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey));
  // Independent frozen producer bytes: historical SDK normalized keys to NFC.
  const canonical = '{"jobId":"delivery-1","é":{"à":"payload"}}';
  const hash = createHash("sha256").update(canonical).digest("hex");
  for (const scope of [
    { jobId: "delivery-1", "e\u0301": { "a\u0300": "payload" } },
    { jobId: "delivery-1", "é": { "à": "payload" } },
  ]) {
    const signature = Buffer.from(ed25519Sign(Buffer.from(`${separator}${hash}`), privateKeyFromSeed(seed))).toString("hex");
    for (const encoded of [signature, `0x${signature}`]) {
      assert.equal(await verifySignedArtifact({ ...scope, signature: encoded }, separator, key, verify), true);
      assert.equal(await verifySignedArtifact({ ...scope, jobId: "changed", signature: encoded }, separator, key, verify), false);
      assert.equal(await verifySignedArtifact({ ...scope, signature: encoded }, separator, new Uint8Array(32), verify), false);
    }
  }
  // Current canonical hashing still distinguishes NFC/NFD member names (CF-1).
  assert.notEqual(contentHash({ "e\u0301": 1 }), contentHash({ "é": 1 }));
});

test("historical adapter refuses unsupported signature shapes without invoking verification", async () => {
  const separator = dacsXSeparator("delivery-attestation") as never;
  let calls = 0;
  for (const signature of [undefined, null, {}, [], 7]) {
    assert.equal(await verifySignedArtifact({ jobId: "delivery-1", signature } as never, separator,
      new Uint8Array(32), () => { calls++; return true; }), false);
  }
  assert.equal(calls, 0);
});

test("historical adapter resolves verifier throws and rejections to strict false", async () => {
  const separator = dacsXSeparator("delivery-attestation") as never;
  const signed = { jobId: "delivery-1", signature: "ab".repeat(64) };
  for (const verify of [() => { throw new Error("verifier failed"); },
    async () => { throw new Error("verifier rejected"); }]) {
    assert.equal(await verifySignedArtifact(signed, separator, new Uint8Array(32), verify), false);
  }
  assert.equal(await verifySignedArtifact(signed, separator, new Uint8Array(32), () => false), false);
});
