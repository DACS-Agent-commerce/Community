import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";

const { POST } = await import("../app/api/dacs/confirm-listing/route.js");

const privateKey = privateKeyFromSeed(Uint8Array.from(Buffer.alloc(32, 21)));
const keyHex = Buffer.from(rawPublicKey(publicKeyFromSeed(Uint8Array.from(Buffer.alloc(32, 21))))).toString("hex");
const sellerClaim = `did:demos:agent:${keyHex}`;
const owner = `0x${keyHex}`;
const anchorAddress = `stor-${"ab".repeat(20)}`;
const programName = "dacs1-ZGFjczEtdmVyaWZpZWQ";
const identity = {
  bundleVersion: "1",
  presentedBy: sellerClaim,
  presentedAt: Date.now(),
  claims: [{ ref: sellerClaim }],
};
const identitySignature = Buffer.from(ed25519Sign(
  Buffer.from(`dacs-bundle-presentation:v1:${contentHash(identity)}`, "utf8"),
  privateKey,
)).toString("hex");
const scope = {
  dacsVersion: "1",
  listingId: "verified-service",
  listingVersion: 1,
  requiredCapabilities: ["SR-2"],
  seller: {
    identity: {
      ...identity,
      presentation: { kind: "per-claim", signatures: [{ ref: sellerClaim, signature: identitySignature }] },
    },
    displayName: "Verified seller",
  },
  offering: {
    title: "Verified service",
    description: "A deterministic verified service.",
    category: "services.other",
    tags: [],
    deliverable: { kind: "attested-payload", payloadFormat: "application/json" },
  },
  buyerRequirement: { requirementVersion: "1", required: [], preferredPresentation: "any" },
  pipeline: [
    { kind: "negotiate-fixed-price" },
    { kind: "commit-agreement" },
    { kind: "pay-dem", parameters: { rail: "pay-dem" } },
    { kind: "deliver-attested-payload" },
  ],
  pricing: { kind: "fixed", price: { amount: "1", currency: "DEM", unit: "per-job" } },
  acceptedRails: [{ railId: "pay-dem" }],
  terms: {},
  validity: { notBefore: identity.presentedAt },
};
const listingHash = contentHash(scope);
const listing = {
  ...scope,
  signature: {
    algorithm: "ed25519",
    signer: sellerClaim,
    value: Buffer.from(ed25519Sign(Buffer.from(`dacs-listing:v1:${listingHash}`, "utf8"), privateKey)).toString("hex"),
  },
};
const coordinates = {
  anchorAddress,
  programName,
  contentHash: listingHash,
  sellerClaim,
  listingId: scope.listingId,
  listingVersion: scope.listingVersion,
};
const request = (body: Record<string, unknown>) => new NextRequest(
  "https://directory.example/api/dacs/confirm-listing",
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
);

test("listing confirmation verifies coordinates, owner, identity, signature, hash, and tuple", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ success: true, data: listing, owner, programName });
  try {
    const response = await POST(request(coordinates));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      confirmed: true,
      state: "verified",
      anchorAddress,
      contentHash: listingHash,
      sellerClaim,
      listingId: scope.listingId,
      listingVersion: 1,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("listing confirmation distinguishes pending visibility from binding failure", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("not found", { status: 404 });
    const pending = await POST(request(coordinates));
    assert.equal(pending.status, 202);
    assert.equal((await pending.json()).state, "not-visible");

    globalThis.fetch = async () => Response.json({
      success: true,
      data: listing,
      owner: `0x${"cd".repeat(32)}`,
      programName,
    });
    const mismatch = await POST(request(coordinates));
    assert.equal(mismatch.status, 409);
    assert.equal((await mismatch.json()).state, "binding-mismatch");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("listing confirmation rejects valid bytes under the wrong expected content hash", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ success: true, data: listing, owner, programName });
  try {
    const response = await POST(request({ ...coordinates, contentHash: "ef".repeat(32) }));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).state, "verification-failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
