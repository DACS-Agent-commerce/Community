import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { dacsXSeparator, ed25519Sign, ed25519Verify, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import * as browserSafeSdk from "@kynesyslabs/dacs";
import { verifySignedArtifact } from "@kynesyslabs/dacs";
import { verifyBundleCore as pureVerifyBundleCore } from "../vendor/dacs-sdk/dist/agent/verifyBundleCore.js";
import { verifySignedArtifact as historicalVerifySignedArtifact } from "../src/sdkVerification.js";

test("the SDK package name resolves to the browser-safe verification seam, not the full SDK barrel", () => {
  assert.deepEqual(Object.keys(browserSafeSdk).sort(), ["verifyBundleCore", "verifySignedArtifact"]);
  assert.equal(browserSafeSdk.verifySignedArtifact, historicalVerifySignedArtifact);
  assert.equal(browserSafeSdk.verifyBundleCore, pureVerifyBundleCore);
});

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

test("historical adapter resolves to false for scopes with no frozen hash form", async () => {
  const separator = dacsXSeparator("delivery-attestation") as never;
  const signature = "ab".repeat(64);
  let calls = 0;
  for (const scope of [{ jobId: "x", n: 1.5 }, { jobId: "x", n: 2 ** 53 }, { jobId: "\ud800" }, { jobId: "x", [`\udc00`]: 1 }]) {
    assert.equal(await verifySignedArtifact({ ...scope, signature }, separator, new Uint8Array(32),
      () => { calls++; return true; }), false);
  }
  assert.equal(calls, 0);
});

test("historical delivery signatures retain top-level and nested NFC-collision insertion order", async () => {
  const seed = new Uint8Array(32).fill(27);
  const key = rawPublicKey(publicKeyFromSeed(seed));
  const separator = dacsXSeparator("delivery-attestation") as never;
  const scope = { "é": "first", "e\u0301": "second", nested: [{ "à": 1, "a\u0300": 2 }] };
  const preimage = '{"nested":[{"à":1,"à":2}],"é":"first","é":"second"}';
  const hash = createHash("sha256").update(preimage).digest("hex");
  const signature = Buffer.from(ed25519Sign(Buffer.from(`${separator}${hash}`), privateKeyFromSeed(seed))).toString("hex");
  const verify = (bytes: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) =>
    ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey));
  assert.equal(await verifySignedArtifact({ ...scope, signature }, separator, key, verify), true);
  assert.equal(await verifySignedArtifact({ ...scope, "é": "changed", signature }, separator, key, verify), false);
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
