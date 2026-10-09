import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { canonicalize, contentHash, listingAddress, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";

const { POST } = await import("../app/api/dacs/confirm-listing/route.js");

const privateKey = privateKeyFromSeed(Uint8Array.from(Buffer.alloc(32, 21)));
const keyHex = Buffer.from(rawPublicKey(publicKeyFromSeed(Uint8Array.from(Buffer.alloc(32, 21))))).toString("hex");
const sellerClaim = `did:demos:agent:${keyHex}`;
const owner = `0x${keyHex}`;
const anchorAddress = `stor-${"ab".repeat(20)}`;
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
    deliverable: {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    },
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
const logicalAddress = listingAddress(sellerClaim, scope.listingId, scope.listingVersion);
const programName = logicalAddress.replaceAll(":", "%3A");
const transactionHash = "cd".repeat(32);
const metadata = {
  logicalAddress,
  contentHash: listingHash,
  envelopeHash: sha256Hex(canonicalize(listing)),
};
const transaction = {
  id: 10,
  status: "confirmed",
  type: "storageProgram",
  hash: transactionHash,
  blockNumber: 5,
  to: anchorAddress,
  content: {
    type: "storageProgram",
    from: owner,
    to: anchorAddress,
    amount: 0,
    data: ["storageProgram", {
      operation: "CREATE_STORAGE_PROGRAM",
      storageAddress: anchorAddress,
      programName,
      encoding: "json",
      data: listing,
      metadata,
      acl: { mode: "public" },
      salt: "",
      storageLocation: "onchain",
    }],
    nonce: 7,
    timestamp: 1_786_360_000_000,
    transaction_fee: { network_fee: 0, rpc_fee: 0, additional_fee: 0, rpc_address: null },
  },
  signature: "signed-envelope",
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
  globalThis.fetch = async (input, init) => {
    if (init?.method !== "POST") {
      return Response.json({
        success: true,
        data: listing,
        owner,
        programName,
        storageAddress: anchorAddress,
        metadata,
        createdByTx: transactionHash,
        interactionTxs: [],
      });
    }
    const rpc = JSON.parse(String(init.body)) as { params: Array<{ message: string; data: Record<string, unknown> }> };
    const call = rpc.params[0]!;
    if (call.message === "getTransactions") return Response.json({ result: 200, response: [transaction] });
    if (call.message === "getBlockByNumber" && call.data.blockNumber === 5) {
      return Response.json({
        result: 200,
        response: {
          status: "confirmed",
          number: 5,
          hash: "block-5",
          content: { timestamp: 1_786_360_000, ordered_transactions: [transactionHash] },
          validation_data: { validators: ["fixture-validator"], quorum: 1 },
        },
      });
    }
    if (call.message === "getBlockByNumber" && call.data.blockNumber === 0) {
      return Response.json({ result: 200, response: { number: 0, hash: "fixture-genesis" } });
    }
    return Response.json({ result: 500, response: null });
  };
  try {
    const response = await POST(request(coordinates));
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.confirmed, true);
    assert.equal(body.state, "finalized-and-verified");
    assert.equal(body.anchorAddress, anchorAddress);
    assert.equal(body.contentHash, listingHash);
    assert.equal(body.sellerClaim, sellerClaim);
    assert.equal(body.listingId, scope.listingId);
    assert.equal(body.listingVersion, 1);
    assert.equal((body.anchorReceipt as Record<string, unknown>).state, "finalized");
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
