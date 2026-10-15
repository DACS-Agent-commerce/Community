import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { isAnchorReceipt } from "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash, listingAddress, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";

const { POST } = await import("../app/api/dacs/confirm-listing/route.js");
const { decodeDemosAnchorReceiptProof, demosSignedTransactionProofHash } = await import(
  "../vendor/dacs-sdk/dist/substrate/demosWriteEvidence.js"
);

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
    value: Buffer.from(ed25519Sign(Buffer.from(`dacs-listing:v1:${listingHash}`, "utf8"), privateKey)).toString("base64url"),
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
  signature: { type: "ed25519", data: `0x${"11".repeat(64)}` },
};
// node2 0.9.8 shapes: getTransactions rows carry `content` and `signature` as
// JSON strings; getTxByHash carries objects and no top-level type/to.
type NodeTransaction = Record<string, unknown> & { content: unknown; signature: unknown };
const historyRow = (tx: NodeTransaction) => ({
  ...tx,
  content: JSON.stringify(tx.content),
  signature: JSON.stringify(tx.signature),
});
const byHashRow = ({ id: _id, type: _type, to: _to, ...tx }: NodeTransaction) => ({ ...tx, ed25519_signature: null });
const blockHash = "ef".repeat(32);
const chainId = "83".repeat(32);
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

/** Stub the Demos node: native readback, canonical write, and its block. */
function stubChain(overrides: {
  nativeMetadata?: Record<string, unknown>;
  transactionMetadata?: Record<string, unknown>;
  block?: Record<string, unknown>;
  history?: boolean;
} = {}): string[] {
  const write = transaction.content.data[1] as Record<string, unknown>;
  const written = overrides.transactionMetadata
    ? { ...transaction, content: { ...transaction.content, data: ["storageProgram", { ...write, metadata: overrides.transactionMetadata }] } }
    : transaction;
  const calls: string[] = [];
  globalThis.fetch = async (_input, init) => {
    if (init?.method !== "POST") {
      return Response.json({
        success: true,
        data: listing,
        owner,
        programName,
        storageAddress: anchorAddress,
        metadata: overrides.nativeMetadata ?? metadata,
      });
    }
    const rpc = JSON.parse(String(init.body)) as { params: Array<{ message: string; data: Record<string, unknown> }> };
    const call = rpc.params[0]!;
    calls.push(call.message);
    if (call.message === "getTransactions") {
      return Response.json({ result: 200, response: overrides.history === false ? [] : [historyRow(written)] });
    }
    if (call.message === "getTxByHash") {
      return call.data.hash === transactionHash
        ? Response.json({ result: 200, response: byHashRow(written) })
        : Response.json({ result: 404, response: "error" });
    }
    if (call.message === "getBlockByNumber" && call.data.blockNumber === 5) {
      return Response.json({
        result: 200,
        response: {
          status: "confirmed",
          number: 5,
          hash: blockHash,
          content: { timestamp: 1_786_360_000, ordered_transactions: [transactionHash] },
          validation_data: { signatures: { [`0x${"aa".repeat(32)}`]: `0x${"bb".repeat(64)}` } },
          ...overrides.block,
        },
      });
    }
    if (call.message === "getBlockByNumber" && call.data.blockNumber === 0) {
      return Response.json({ result: 400, response: "error", extra: "Block number not provided" });
    }
    if (call.message === "getBlockByNumber" && call.data.blockNumber === 1) {
      return Response.json({
        result: 200,
        response: { id: 2, number: 1, status: "confirmed", hash: "12".repeat(32), content: { previousHash: chainId, timestamp: 1 } },
      });
    }
    return Response.json({ result: 500, response: null });
  };
  return calls;
}

test("listing confirmation verifies coordinates, owner, identity, signature, hash, and tuple", async () => {
  const originalFetch = globalThis.fetch;
  stubChain();
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
    const receipt = body.anchorReceipt as Record<string, unknown>;
    assert.equal(isAnchorReceipt(receipt), true);
    assert.equal(receipt.state, "finalized");
    assert.equal(receipt.observationDisposition, "established");
    assert.equal(receipt.logicalAddress, logicalAddress);
    assert.equal(receipt.nativeAddress, anchorAddress);
    assert.equal(receipt.contentHash, listingHash);
    assert.deepEqual(receipt.transactionRef, { kind: "demos-storage-program", value: transactionHash });
    // node2 serves block timestamps in seconds; the receipt carries milliseconds.
    assert.deepEqual(receipt.blockRef, { id: blockHash, height: "5", timestamp: 1_786_360_000_000 });
    const proof = decodeDemosAnchorReceiptProof(receipt as never);
    assert.equal(proof.chainIdentity, chainId, "block zero answers `error`, so block one's predecessor names the chain");
    // Portable: the SDK verifier re-reads getTxByHash, whose signature is an object.
    assert.equal(proof.signedTransactionHash, demosSignedTransactionProofHash(byHashRow(transaction)));
    assert.equal(proof.nativeRead.metadataHash, sha256Hex(canonicalize(metadata)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("listing confirmation reads a browser-supplied transactionRef by hash", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const transactionRef of [transactionHash, transactionHash.toUpperCase()]) {
      // The write is outside the newest-history window; only the by-hash read finds it.
      const calls = stubChain({ history: false });
      const response = await POST(request({ ...coordinates, transactionRef }));
      assert.equal(response.status, 200, transactionRef);
      const body = await response.json() as { state: string; anchorReceipt: Record<string, unknown> };
      assert.equal(body.state, "finalized-and-verified");
      assert.deepEqual(body.anchorReceipt.transactionRef, { kind: "demos-storage-program", value: transactionHash });
      assert.equal(
        decodeDemosAnchorReceiptProof(body.anchorReceipt as never).signedTransactionHash,
        demosSignedTransactionProofHash(byHashRow(transaction)),
      );
      assert.ok(calls.includes("getTxByHash"));
    }
    // Another transaction never stands in for the browser's own write.
    stubChain();
    const other = await POST(request({ ...coordinates, transactionRef: "ef".repeat(32) }));
    assert.equal(other.status, 202);
    assert.equal((await other.json() as { state: string }).state, "finality-pending");
    const malformed = await POST(request({ ...coordinates, transactionRef: "not-a-hash" }));
    assert.equal(malformed.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("listing confirmation never registers before the write is BFT-final", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const block of [
      { status: "pending" },
      { content: { timestamp: 1_786_360_000, ordered_transactions: [] } },
      { validation_data: undefined },
      // Placeholder proofs and block references that the node never serves.
      { validation_data: { validators: ["fixture-validator"], quorum: 1 } },
      { validation_data: { signatures: {} } },
      { validation_data: { signatures: { "fixture-validator": "signed" } } },
      { hash: "block-5" },
      { hash: "" },
    ]) {
      stubChain({ block });
      const response = await POST(request(coordinates));
      assert.equal(response.status, 202, JSON.stringify(block));
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body.confirmed, false);
      assert.equal(body.state, "finality-pending");
      assert.equal(body.anchorReceipt, undefined);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("listing confirmation rejects native metadata that does not bind the signed artifact", async () => {
  const originalFetch = globalThis.fetch;
  const unbound = { ...metadata, envelopeHash: "0".repeat(64) };
  try {
    for (const overrides of [
      { nativeMetadata: unbound },
      // Native and transaction metadata agree, but neither hashes the anchored envelope.
      { nativeMetadata: unbound, transactionMetadata: unbound },
    ]) {
      stubChain(overrides);
      const response = await POST(request(coordinates));
      assert.equal(response.status, 409, Object.keys(overrides).join("+"));
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body.state, "finality-failed");
      assert.equal(body.anchorReceipt, undefined);
    }
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
