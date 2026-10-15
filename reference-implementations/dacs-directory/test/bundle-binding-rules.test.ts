import assert from "node:assert/strict";
import test from "node:test";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import {
  boundedBundleBindings,
  logicalBundleAddress,
  MAX_BUNDLE_BINDING_CANDIDATES_PER_SIGNER,
  MAX_BUNDLE_BINDINGS_PER_JOB_ROLE,
  resolveBundleSide,
  verifyBundleBinding,
} from "../src/catalog/bundleBinding.js";
import type { BundleBinding } from "../src/catalog/types.js";

// DACS-5 BB-4..BB-7, one case per rule. Each malformed binding is signed again, so only the rule
// under test can reject it.
type Obj = Record<string, unknown>;
const seeds = [71, 72].map((byte) => Uint8Array.from(Buffer.alloc(32, byte)));
const dids = seeds.map((seed) => `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`);
const native = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;
const JOB = "binding-rules";

function scopeFor(change: Obj = {}): Obj {
  return { bindingVersion: "1", jobId: JOB, role: "buyer", logicalAddress: logicalBundleAddress(JOB, "buyer"), nativeAddress: native(1),
    bundleContentHash: "a".repeat(64), signer: dids[0], ...change };
}
const signed = (scope: Obj, signer = 0, envelope: Obj = {}): Obj => ({
  ...scope,
  signature: { algorithm: "ed25519", signer: dids[signer],
    value: Buffer.from(ed25519Sign(Buffer.from(`dacs-bundle-binding:v1:${contentHash(scope)}`, "utf8"), privateKeyFromSeed(seeds[signer]))).toString("base64url"), ...envelope },
});
const binding = (change: Obj = {}, signer = 0) => signed(scopeFor(change), signer) as unknown as BundleBinding;

test("BB-4: a binding's members, envelope and signature", async () => {
  const verdict = async (value: unknown) => (await verifyBundleBinding(value)) !== null;
  const accepted: Record<string, unknown> = {
    "the base binding": binding(),
    "a 160-character jobId": signed(scopeFor({ jobId: "j".repeat(160), logicalAddress: logicalBundleAddress("j".repeat(160), "buyer") })),
    "each role": signed(scopeFor({ role: "orchestrator" })),
    "a 256-character anchorTx": signed(scopeFor({ anchorTx: "t".repeat(256) })),
    "an unknown member": signed(scopeFor({ futureMember: { kept: true } })),
  };
  const rejected: Record<string, unknown> = {
    "not an object": "binding",
    "a list": [binding()],
    "bindingVersion 2": signed(scopeFor({ bindingVersion: "2" })),
    "a jobId that is not a string": signed(scopeFor({ jobId: 7 })),
    "an empty jobId": signed(scopeFor({ jobId: "" })),
    "a 161-character jobId": signed(scopeFor({ jobId: "j".repeat(161) })),
    "a role that is not a string": signed(scopeFor({ role: 7 })),
    "an unknown role": signed(scopeFor({ role: "auditor" })),
    "a logical address that is not a string": signed(scopeFor({ logicalAddress: 7 })),
    "a native-form logical address": signed(scopeFor({ logicalAddress: native(2) })),
    "a native address that is not a string": signed(scopeFor({ nativeAddress: 7 })),
    "a logical-form native address": signed(scopeFor({ nativeAddress: logicalBundleAddress(JOB, "buyer") })),
    "a content hash that is not a string": signed(scopeFor({ bundleContentHash: 7 })),
    "an uppercase content hash": signed(scopeFor({ bundleContentHash: "A".repeat(64) })),
    "an anchorTx that is not a string": signed(scopeFor({ anchorTx: 7 })),
    "a 257-character anchorTx": signed(scopeFor({ anchorTx: "t".repeat(257) })),
    "a signer that is not a string": signed(scopeFor({ signer: 7 })),
    "no signature": scopeFor(),
    "another algorithm": signed(scopeFor(), 0, { algorithm: "ecdsa-secp256k1" }),
    "an envelope signer that is not a string": signed(scopeFor(), 0, { signer: 7 }),
    "an envelope value that is not a string": signed(scopeFor(), 0, { value: 7 }),
    "a signer with no resolvable key": signed(scopeFor({ signer: `cci:${"8".repeat(64)}` })),
    "an envelope naming another signer": signed(scopeFor(), 1),
    "a padded envelope value": { ...binding(), signature: { ...binding().signature, value: `${binding().signature.value}==` } },
    "another key's signature for this signer": { ...binding(), signature: { ...binding({}, 1).signature, signer: dids[0] } },
    "over 16 KiB serialized": signed(scopeFor({ padding: "p".repeat(16_384) })),
  };
  assert.deepEqual(Object.fromEntries(await Promise.all(Object.entries(accepted).map(async ([name, value]) => [name, await verdict(value)]))),
    Object.fromEntries(Object.keys(accepted).map((name) => [name, true])));
  assert.deepEqual(Object.fromEntries(await Promise.all(Object.entries(rejected).map(async ([name, value]) => [name, await verdict(value)]))),
    Object.fromEntries(Object.keys(rejected).map((name) => [name, false])));
  // The verified binding keeps unknown members and only the three envelope members.
  const kept = await verifyBundleBinding({ ...signed(scopeFor({ futureMember: 1 })), signature: { ...signed(scopeFor({ futureMember: 1 })).signature as Obj } });
  assert.equal((kept as unknown as Obj).futureMember, 1);
  assert.deepEqual(Object.keys(kept!.signature).sort(), ["algorithm", "signer", "value"]);
});

test("BB-6: the stored ceiling is per signer of each job and role, and its overflow is reported", () => {
  const many = (count: number, signer = 0, role = "buyer") => Array.from({ length: count }, (_, n) =>
    binding({ nativeAddress: native(100 + n), role, logicalAddress: logicalBundleAddress(JOB, role as BundleBinding["role"]), signer: dids[signer] }, signer));
  const exact = boundedBundleBindings(many(MAX_BUNDLE_BINDINGS_PER_JOB_ROLE));
  assert.equal(exact.bindings.length, MAX_BUNDLE_BINDINGS_PER_JOB_ROLE);
  assert.deepEqual(exact.overflowKeys, []);
  const over = boundedBundleBindings(many(MAX_BUNDLE_BINDINGS_PER_JOB_ROLE + 1));
  assert.equal(over.bindings.length, MAX_BUNDLE_BINDINGS_PER_JOB_ROLE);
  assert.deepEqual(over.overflowKeys, [`${JOB}\nbuyer\n${dids[0]}`]);
  // Another signer's or another role's bindings never share the budget, and duplicates count once.
  const mixed = boundedBundleBindings([...many(MAX_BUNDLE_BINDINGS_PER_JOB_ROLE), ...many(3, 1), ...many(2, 0, "seller"), ...many(4)]);
  assert.equal(mixed.bindings.length, MAX_BUNDLE_BINDINGS_PER_JOB_ROLE + 5);
  assert.deepEqual(mixed.overflowKeys, []);
  // The retained window is deterministic: the same input in any order keeps the same bindings.
  const shuffled = boundedBundleBindings([...many(MAX_BUNDLE_BINDINGS_PER_JOB_ROLE + 6)].reverse());
  assert.deepEqual(shuffled.bindings.map((value) => value.nativeAddress), boundedBundleBindings(many(MAX_BUNDLE_BINDINGS_PER_JOB_ROLE + 6)).bindings.map((value) => value.nativeAddress));
});

test("BB-5..BB-7: a side resolves only from its role holder's bindings, within budget, to one authoritative copy", async () => {
  const inspectAll = async (value: BundleBinding) => ({ value: value.nativeAddress, bundleContentHash: value.bundleContentHash, fullSignatureStanding: true });
  const resolve = (bindings: BundleBinding[], options: Partial<Parameters<typeof resolveBundleSide<string>>[0]> = {}) =>
    resolveBundleSide<string>({ jobId: JOB, role: "buyer", expectedSigner: dids[0], bindings, inspect: inspectAll, ...options });
  const base = binding();
  assert.deepEqual(await resolve([base]), { disposition: "present", binding: base, inspected: { value: native(1), bundleContentHash: "a".repeat(64), fullSignatureStanding: true } });
  const reason = async (bindings: BundleBinding[], options: Partial<Parameters<typeof resolveBundleSide<string>>[0]> = {}) => {
    const side = await resolve(bindings, options);
    return side.disposition === "present" ? `present ${side.binding.nativeAddress}` : side.reason;
  };
  const sellerBinding = binding({ role: "seller", logicalAddress: logicalBundleAddress(JOB, "seller") });
  const NONE = "no verified BundleBinding for role";
  assert.deepEqual({
    "an expected signer that is not a Demos agent claim": await reason([base], { expectedSigner: "cci:someone" }),
    "a sticky overflow": await reason([base], { overflow: true }),
    "a binding for another job": await reason([binding({ jobId: "other", logicalAddress: logicalBundleAddress("other", "buyer") })]),
    "a binding for another role": await reason([sellerBinding]),
    "a logical address for another role": await reason([binding({ logicalAddress: logicalBundleAddress(JOB, "seller") })]),
    "another signer's binding": await reason([binding({ signer: dids[1] }, 1)]),
    "exactly the budget of distinct copies": await reason(Array.from({ length: MAX_BUNDLE_BINDING_CANDIDATES_PER_SIGNER }, (_, n) => binding({ nativeAddress: native(10 + n) }))),
    "one copy over the budget": await reason(Array.from({ length: MAX_BUNDLE_BINDING_CANDIDATES_PER_SIGNER + 1 }, (_, n) => binding({ nativeAddress: native(10 + n) }))),
    "every copy failing its post-fetch check": await reason([base], { inspect: async () => null }),
    "a copy whose content hash differs": await reason([base], { inspect: async (value) => ({ value: value.nativeAddress, bundleContentHash: "b".repeat(64), fullSignatureStanding: true }) }),
    "two equal-standing divergent copies": await reason([base, binding({ nativeAddress: native(2), bundleContentHash: "b".repeat(64) })]),
    "a lone fully signed copy beside a lesser one": await reason([base, binding({ nativeAddress: native(2), bundleContentHash: "b".repeat(64) })], {
      inspect: async (value) => ({ value: value.nativeAddress, bundleContentHash: value.bundleContentHash, fullSignatureStanding: value.nativeAddress === native(2) }),
    }),
  }, {
    "an expected signer that is not a Demos agent claim": "role holder is not a supported canonical claim",
    "a sticky overflow": "bundle-binding discovery cap exhausted",
    "a binding for another job": NONE, "a binding for another role": NONE, "a logical address for another role": NONE,
    "another signer's binding": NONE,
    "exactly the budget of distinct copies": "present stor-000000000000000000000000000000000000000a",
    "one copy over the budget": "BB-6 per-signer fetch budget exhausted",
    "every copy failing its post-fetch check": "every BundleBinding failed BB-5 post-fetch checks",
    "a copy whose content hash differs": "every BundleBinding failed BB-5 post-fetch checks",
    "two equal-standing divergent copies": "authorized equal-standing bundle copies diverge",
    "a lone fully signed copy beside a lesser one": `present ${native(2)}`,
  });
});

test("BB-4 and BB-6 boundaries: a one-character jobId, and a lone copy without full standing still resolves", async () => {
  assert.notEqual(await verifyBundleBinding(signed(scopeFor({ jobId: "j", logicalAddress: logicalBundleAddress("j", "buyer") }))), null);
  const lone = binding();
  const side = await resolveBundleSide<string>({ jobId: JOB, role: "buyer", expectedSigner: dids[0], bindings: [lone],
    inspect: async (value) => ({ value: value.nativeAddress, bundleContentHash: value.bundleContentHash, fullSignatureStanding: false }) });
  assert.equal(side.disposition, "present");
});
