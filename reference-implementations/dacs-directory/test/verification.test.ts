import assert from "node:assert/strict";
import test from "node:test";

import { contentHash } from "@kynesyslabs/dacs/canonical";
import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
} from "@kynesyslabs/dacs/crypto";

import { hasRequiredBundleSignatures, refsPassStrictPolicy } from "../src/catalog/bundlePolicy.js";
import { indexRegistration } from "../src/catalog/indexer.js";
import { ownerClaim, verifyListing } from "../src/catalog/listingVerification.js";
import type { BundleVerification } from "../vendor/dacs-sdk/dist/agent/verifyBundleCore.js";

const seed = Uint8Array.from(Buffer.alloc(32, 7));
const did = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;

const listing = {
  listingId: "svc",
  listingVersion: 1,
  agentId: did,
  serviceId: "svc",
  name: "Service",
  description: "Description",
  claimRequirements: [],
  supportedNegotiation: ["negotiate-fixed-price"],
  supportedPaymentRails: ["pay-dem"],
  supportedDelivery: ["deliver-attested-payload"],
};

test("listing verification requires a valid signer-bound envelope", async () => {
  const message = Buffer.from(`dacs-listing:v1:${contentHash(listing)}`, "utf8");
  const value = Buffer.from(await ed25519Sign(message, privateKeyFromSeed(seed))).toString("hex");
  const signed = { ...listing, signature: { algorithm: "ed25519", signer: did, value } };
  assert.ok(await verifyListing(signed));
  assert.equal(await verifyListing({ ...signed, name: "tampered" }), null);
  assert.equal(await verifyListing({ ...listing, signature: "deadbeef" }), null);
  assert.equal(ownerClaim(`0x${did.slice(-64)}`), did);
});

function result(outcome: string, signatures: BundleVerification["signatures"]): BundleVerification {
  return {
    ok: true,
    fullyVerified: signatures.every((s) => s.verdict === "valid"),
    signatures,
    refs: [],
    bundle: {
      bundleVersion: "1",
      jobId: "j",
      outcome,
      listingRef: { listingId: "svc", version: 1, contentHash: "h" },
      agreementRef: { kind: "dacs-3-agreement", id: "a", contentHash: "h" },
      parties: [
        { role: "buyer", primaryClaim: "buyer", bundleHash: "b" },
        { role: "seller", primaryClaim: "seller", bundleHash: "s" },
      ],
      phaseSummary: [],
      vetRecords: [],
      settlementEvidence: [],
      recipeRegistryVersion: 1,
      railRegistryVersion: 1,
      finalisedAt: 1,
    },
  };
}

test("strict bundle policy rejects one-sided completed bundles", () => {
  assert.equal(hasRequiredBundleSignatures(result("completed", [{ party: "buyer", verdict: "valid" }])), false);
  assert.equal(hasRequiredBundleSignatures(result("completed", [
    { party: "buyer", verdict: "valid" },
    { party: "seller", verdict: "valid" },
  ])), true);
  assert.equal(hasRequiredBundleSignatures(result("aborted-by-other", [{ party: "buyer", verdict: "valid" }])), true);
});

test("strict ref policy rejects unsigned referenced artifacts", async () => {
  const verification = result("completed", [
    { party: "buyer", verdict: "valid" },
    { party: "seller", verdict: "valid" },
  ]);
  verification.refs = [{ kind: "dacs-4-evidence", id: "e", verdict: "ok" }];
  assert.equal(await refsPassStrictPolicy(verification, [{
    kind: "dacs-4-evidence",
    raw: { evidenceVersion: "1", jobId: "j" },
  }]), false);
});

test("indexer rejects a shape-valid listing with a fake signature", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    success: true,
    owner: `0x${did.slice(-64)}`,
    programName: "dacs1:listing:test",
    data: { ...listing, signature: "deadbeef" },
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const record = await indexRegistration(
      { primaryClaim: did, displayName: "Victim", listingAnchors: [`stor-${"c".repeat(40)}`] },
      undefined,
      async () => { throw new Error("identity unavailable"); },
    );
    assert.equal(record.listings.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
