import assert from "node:assert/strict";
import test from "node:test";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import {
  boundedBundleBindings,
  bundleBindingRoleKey,
  logicalBundleAddress,
  resolveBundleSide,
  verifyBundleBinding,
} from "../src/catalog/bundleBinding.js";
import type { BundleBinding } from "../src/catalog/types.js";

const seeds = [31, 32].map((byte) => Uint8Array.from(Buffer.alloc(32, byte)));
const dids = seeds.map((seed) =>
  `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`);
const native = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;

async function binding(options: {
  jobId?: string;
  role?: BundleBinding["role"];
  signer?: number;
  native?: string;
  hash?: string;
  logical?: string;
} = {}): Promise<BundleBinding> {
  const jobId = options.jobId ?? "job-binding-1";
  const role = options.role ?? "buyer";
  const signer = options.signer ?? 0;
  const scope = {
    bindingVersion: "1" as const,
    jobId,
    role,
    logicalAddress: options.logical ?? logicalBundleAddress(jobId, role),
    nativeAddress: options.native ?? native(1),
    bundleContentHash: options.hash ?? "a".repeat(64),
    signer: dids[signer],
  };
  const value = Buffer.from(await ed25519Sign(
    Buffer.from(`dacs-bundle-binding:v1:${contentHash(scope)}`, "utf8"),
    privateKeyFromSeed(seeds[signer]),
  )).toString("base64url");
  return { ...scope, signature: { algorithm: "ed25519", signer: dids[signer], value } };
}

test("BB-4 verifies the signed scope and derives the normative logical address", async () => {
  const candidate = await binding();
  assert.equal(logicalBundleAddress(candidate.jobId, candidate.role), candidate.logicalAddress);
  assert.deepEqual(await verifyBundleBinding(candidate), candidate);
  assert.equal(await verifyBundleBinding({ ...candidate, nativeAddress: native(2) }), null);
  assert.equal(await verifyBundleBinding({
    ...candidate,
    signature: { ...candidate.signature, signer: dids[1] },
  }), null);
  assert.equal(await verifyBundleBinding({
    ...candidate,
    signature: { ...candidate.signature, value: `${candidate.signature.value}==` },
  }), null, "SIG-6 rejects padded base64url");
});

test("BB-5 request matching rejects a validly signed inconsistent logical mapping", async () => {
  const wrong = await binding({ logical: `stor-${"f".repeat(64)}` });
  assert.ok(await verifyBundleBinding(wrong), "BB-4 alone is valid");
  const resolution = await resolveBundleSide({
    jobId: wrong.jobId,
    role: "buyer",
    expectedSigner: dids[0],
    bindings: [wrong],
    inspect: async () => ({ value: "unused", bundleContentHash: wrong.bundleContentHash, fullSignatureStanding: true }),
  });
  assert.deepEqual(resolution, { disposition: "indeterminate", reason: "no verified BundleBinding for role" });
});

test("BB-6 prefers one fully signed canonical group and makes equal standing divergence indeterminate", async () => {
  const lesser = await binding({ native: native(1), hash: "a".repeat(64) });
  const full = await binding({ native: native(2), hash: "b".repeat(64) });
  const selected = await resolveBundleSide({
    jobId: full.jobId,
    role: "buyer",
    expectedSigner: dids[0],
    bindings: [lesser, full],
    inspect: async (candidate) => ({
      value: candidate.nativeAddress,
      bundleContentHash: candidate.bundleContentHash,
      fullSignatureStanding: candidate.nativeAddress === full.nativeAddress,
    }),
  });
  assert.equal(selected.disposition, "present");
  if (selected.disposition === "present") assert.equal(selected.binding.nativeAddress, full.nativeAddress);

  const divergent = await resolveBundleSide({
    jobId: full.jobId,
    role: "buyer",
    expectedSigner: dids[0],
    bindings: [lesser, full],
    inspect: async (candidate) => ({ value: candidate.nativeAddress, bundleContentHash: candidate.bundleContentHash, fullSignatureStanding: true }),
  });
  assert.deepEqual(divergent, { disposition: "indeterminate", reason: "authorized equal-standing bundle copies diverge" });
});

test("BB-6 budget and the total discovery ceiling fail closed", async () => {
  const candidates = await Promise.all(Array.from({ length: 9 }, (_, index) =>
    binding({ native: native(index + 1), hash: (index + 1).toString(16).repeat(64).slice(0, 64) })));
  let inspected = 0;
  const exhausted = await resolveBundleSide({
    jobId: candidates[0].jobId,
    role: "buyer",
    expectedSigner: dids[0],
    bindings: candidates,
    inspect: async (candidate) => {
      inspected++;
      return { value: candidate, bundleContentHash: candidate.bundleContentHash, fullSignatureStanding: true };
    },
  });
  assert.deepEqual(exhausted, { disposition: "indeterminate", reason: "BB-6 per-signer fetch budget exhausted" });
  assert.equal(inspected, 0, "budget exhaustion does no partial authoritative read");

  const bounded = boundedBundleBindings(candidates, 8);
  assert.equal(bounded.bindings.length, 8);
  assert.deepEqual(bounded.overflowKeys, [bundleBindingRoleKey(candidates[0].jobId, "buyer")]);
  const overflow = await resolveBundleSide({
    jobId: candidates[0].jobId,
    role: "buyer",
    expectedSigner: dids[0],
    bindings: bounded.bindings,
    overflow: true,
    inspect: async () => { throw new Error("must not fetch"); },
  });
  assert.deepEqual(overflow, { disposition: "indeterminate", reason: "bundle-binding discovery cap exhausted" });
});

test("BB-5 poisoned content hashes are inert and cannot win selection", async () => {
  const poisoned = await binding({ native: native(1), hash: "a".repeat(64) });
  const honest = await binding({ native: native(2), hash: "b".repeat(64) });
  const resolution = await resolveBundleSide({
    jobId: honest.jobId,
    role: "buyer",
    expectedSigner: dids[0],
    bindings: [poisoned, honest],
    inspect: async (candidate) => ({
      value: candidate.nativeAddress,
      bundleContentHash: candidate === poisoned ? "c".repeat(64) : candidate.bundleContentHash,
      fullSignatureStanding: true,
    }),
  });
  assert.equal(resolution.disposition, "present");
  if (resolution.disposition === "present") assert.equal(resolution.binding.nativeAddress, honest.nativeAddress);
});

test("BB-6 prunes outsider signers before fetch and orders authorized work by hash then address", async () => {
  const later = await binding({ native: native(1), hash: "b".repeat(64) });
  const earlier = await binding({ native: native(2), hash: "a".repeat(64) });
  const outsider = await binding({ signer: 1, native: native(3), hash: "0".repeat(64) });
  const inspected: string[] = [];
  const resolution = await resolveBundleSide({
    jobId: earlier.jobId,
    role: "buyer",
    expectedSigner: dids[0],
    bindings: [later, outsider, earlier],
    inspect: async (candidate) => {
      inspected.push(candidate.nativeAddress);
      return { value: candidate, bundleContentHash: candidate.bundleContentHash, fullSignatureStanding: true };
    },
  });
  assert.deepEqual(inspected, [earlier.nativeAddress, later.nativeAddress]);
  assert.equal(resolution.disposition, "indeterminate", "two authorized full-standing hashes equivocate");
  assert.ok(!inspected.includes(outsider.nativeAddress));
});
