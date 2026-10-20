import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { canonicalize, contentHash, listingAddress, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";

const { POST } = await import("../app/api/dacs/confirm-listing/route.js");
const { PINNED_DEMOS_CHAIN_IDENTITY, nodeBuildRejection, pinnedChainIdentity, pinnedNodeBuilds } = await import(
  "../src/catalog/nodeDeployment.js"
);
const { demosSignedTransactionProofHash } = await import(
  "../vendor/dacs-sdk/dist/substrate/demosWriteEvidence.js"
);
type Observation = Record<string, unknown> & { chainIdentity: string; signedTransactionHash: string; nativeRead: Record<string, unknown> };

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
)).toString("base64url");
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
// The fixture chain stands in for the pinned Demos deployment.
process.env.DEMOS_CHAIN_IDENTITY = chainId;
const pinnedCommit = "61b8e75aa8db5e408c49e1c3a89db4d673f45578";
const cleanBuild = { name: "demos-node-software", version: "0.9.8", commit: pinnedCommit, dirty: false };
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

/** Every getTransactions request the stub served since the last stubChain. */
const historyRequests: Array<Record<string, unknown>> = [];
const write = transaction.content.data[1] as Record<string, unknown>;
/** A confirmed storage write in node history, varied from the listing's own. */
function historyWrite(id: number, hash: string, change: { to?: string; data?: Record<string, unknown> } = {}): NodeTransaction {
  const to = change.to ?? anchorAddress;
  return {
    ...transaction, id, hash, to,
    content: { ...transaction.content, to, data: ["storageProgram", { ...write, storageAddress: to, ...(change.data ? { data: change.data } : {}) }] },
  };
}
/** A confirmed transfer, which is no storage write at all. */
const transfer = (id: number | undefined): NodeTransaction => ({
  id, status: "confirmed", type: "native", hash: (id ?? 0).toString(16).padStart(64, "9"), blockNumber: 4,
  content: { type: "native", from: owner, to: owner, amount: 1, data: ["native", {}] }, signature: transaction.signature,
});

/** Stub the Demos node: native readback, canonical write, and its block. */
function stubChain(overrides: {
  nativeMetadata?: Record<string, unknown>;
  transactionMetadata?: Record<string, unknown>;
  block?: Record<string, unknown>;
  history?: boolean;
  /** Block zero's answer; by default node2's `result: 400` error. */
  genesis?: Record<string, unknown>;
  /** Members replacing block one's. */
  first?: Record<string, unknown>;
  /** Members replacing the getTxByHash row's. */
  byHash?: Record<string, unknown>;
  /** getNetworkInfo's `nodeVersion`; a clean build of the pinned commit by default. */
  nodeVersion?: Record<string, unknown> | null;
  /** getTxByHash answers node2's unknown-hash `result: 400` for every hash. */
  byHashUnknown?: boolean;
  /** getTransactions pages keyed by `start`; by default one newest page holding the write. */
  historyPages?: Record<string, NodeTransaction[]>;
  /** Members replacing the native readback's. */
  native?: Record<string, unknown>;
} = {}): string[] {
  const write = transaction.content.data[1] as Record<string, unknown>;
  const written = overrides.transactionMetadata
    ? { ...transaction, content: { ...transaction.content, data: ["storageProgram", { ...write, metadata: overrides.transactionMetadata }] } }
    : transaction;
  const calls: string[] = [];
  historyRequests.length = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method !== "POST") {
      return Response.json({
        success: true,
        data: listing,
        owner,
        programName,
        storageAddress: anchorAddress,
        metadata: overrides.nativeMetadata ?? metadata,
        ...overrides.native,
      });
    }
    const rpc = JSON.parse(String(init.body)) as { params: Array<{ message: string; data: Record<string, unknown> }> };
    const call = rpc.params[0]!;
    calls.push(call.message);
    if (call.message === "getTransactions") {
      historyRequests.push(call.data);
      if (overrides.historyPages) {
        return Response.json({ result: 200, response: (overrides.historyPages[String(call.data.start)] ?? []).map(historyRow) });
      }
      return Response.json({ result: 200, response: overrides.history === false ? [] : [historyRow(written)] });
    }
    if (call.message === "getTxByHash") {
      if (overrides.byHashUnknown) return Response.json({ result: 400, response: "error" });
      return call.data.hash === transactionHash
        ? Response.json({ result: 200, response: { ...byHashRow(written), ...overrides.byHash } })
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
    if (call.message === "getNetworkInfo") {
      const nodeVersion = overrides.nodeVersion === undefined ? cleanBuild : overrides.nodeVersion;
      return Response.json({ result: 200, response: { forks: {}, ...(nodeVersion ? { nodeVersion } : {}) } });
    }
    if (call.message === "getBlockByNumber" && call.data.blockNumber === 0) {
      return overrides.genesis
        ? Response.json({ result: 200, response: overrides.genesis })
        : Response.json({ result: 400, response: "error", extra: "Block number not provided" });
    }
    if (call.message === "getBlockByNumber" && call.data.blockNumber === 1) {
      return Response.json({
        result: 200,
        response: { id: 2, number: 1, status: "confirmed", hash: "12".repeat(32), content: { previousHash: chainId, timestamp: 1 }, ...overrides.first },
      });
    }
    return Response.json({ result: 500, response: null });
  };
  return calls;
}

test("a node-reported inclusion is an unauthenticated observation, never a receipt or a confirmation", async () => {
  const originalFetch = globalThis.fetch;
  stubChain();
  try {
    const response = await POST(request(coordinates));
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    // DEMOS-MAPPING SR-2: an `included` Demos write is also final, and neither is
    // verified here, so LP-1 is unmet and the browser must not register.
    assert.equal(body.confirmed, false);
    assert.equal(body.state, "finality-unverified");
    assert.match(String(body.error), /cannot verify Demos finality \(DACS-1 LP-1\)/);
    assert.equal(body.authenticated, false);
    assert.equal(body.anchorReceipt, undefined, "no CORE §5.1 AnchorReceipt is issued");
    assert.equal(body.anchorAddress, anchorAddress);
    assert.equal(body.contentHash, listingHash);
    assert.equal(body.sellerClaim, sellerClaim);
    assert.equal(body.listingId, scope.listingId);
    assert.equal(body.listingVersion, 1);
    const observation = body.nodeObservation as Observation;
    assert.equal(observation.logicalAddress, logicalAddress);
    assert.equal(observation.nativeAddress, anchorAddress);
    assert.equal(observation.contentHash, listingHash);
    assert.equal(observation.writer, sellerClaim);
    assert.equal(observation.transactionRef, transactionHash);
    assert.equal(observation.nodeBuild, pinnedCommit);
    assert.equal(observation.blockNumber, 5);
    assert.equal(observation.blockHash, blockHash);
    // node2 serves block timestamps in seconds; the observation carries milliseconds.
    assert.equal(observation.blockTimestamp, 1_786_360_000_000);
    assert.equal(
      observation.validationDataHash,
      sha256Hex(canonicalize({ signatures: { [`0x${"aa".repeat(32)}`]: `0x${"bb".repeat(64)}` } })),
    );
    assert.equal(observation.chainIdentity, chainId, "block zero answers `error`, so block one's predecessor names the chain");
    // The SDK's proof hash of the getTxByHash form, whose signature is an object.
    assert.equal(observation.signedTransactionHash, demosSignedTransactionProofHash(byHashRow(transaction)));
    assert.equal(observation.nativeRead.metadataHash, sha256Hex(canonicalize(metadata)));
    assert.equal(observation.nativeRead.owner, owner, "the native readback's owner");
    assert.equal(observation.nativeRead.programName, programName);
    assert.equal(observation.nativeRead.valueHash, sha256Hex(canonicalize(listing)));
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
      const body = await response.json() as { state: string; nodeObservation: Observation };
      assert.equal(body.state, "finality-unverified");
      assert.equal(body.nodeObservation.transactionRef, transactionHash);
      assert.equal(
        body.nodeObservation.signedTransactionHash,
        demosSignedTransactionProofHash(byHashRow(transaction)),
      );
      assert.ok(calls.includes("getTxByHash"));
    }
    // Another transaction never stands in for the browser's own write.
    stubChain();
    const other = await POST(request({ ...coordinates, transactionRef: "ef".repeat(32) }));
    assert.equal(other.status, 202);
    const otherBody = await other.json() as { state: string; confirmed: unknown };
    assert.equal(otherBody.state, "inclusion-pending");
    assert.equal(otherBody.confirmed, false);
    const malformed = await POST(request({ ...coordinates, transactionRef: "not-a-hash" }));
    assert.equal(malformed.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("listing confirmation never registers before the write is in a node-confirmed block", async () => {
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
      // The block the node serves must be the transaction's own, under an exact hash.
      { number: 6 },
      { hash: `0x${blockHash}` },
      { hash: `${blockHash}00` },
    ]) {
      stubChain({ block });
      const response = await POST(request(coordinates));
      assert.equal(response.status, 202, JSON.stringify(block));
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body.confirmed, false);
      assert.equal(body.state, "inclusion-pending");
      assert.equal(body.nodeObservation, undefined);
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
      assert.equal(body.confirmed, false);
      assert.equal(body.state, "inclusion-failed");
      assert.equal(body.nodeObservation, undefined);
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
    assert.deepEqual(await pending.json(), { confirmed: false, state: "not-visible" });

    globalThis.fetch = async () => Response.json({
      success: true,
      data: listing,
      owner: `0x${"cd".repeat(32)}`,
      programName,
    });
    const mismatch = await POST(request(coordinates));
    assert.equal(mismatch.status, 409);
    const mismatchBody = await mismatch.json();
    assert.equal(mismatchBody.confirmed, false);
    assert.equal(mismatchBody.state, "binding-mismatch");
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
    const body = await response.json();
    assert.equal(body.confirmed, false);
    assert.equal(body.state, "verification-failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/** The observation's chain identity when `pinned` is the pinned chain, or the confirmation state. */
async function chainIdentityFor(overrides: Parameters<typeof stubChain>[0], pinned = chainId): Promise<string> {
  stubChain(overrides);
  process.env.DEMOS_CHAIN_IDENTITY = pinned;
  try {
    const response = await POST(request(coordinates));
    const body = await response.json() as { state: string; nodeObservation?: Observation };
    return response.status === 200 ? body.nodeObservation!.chainIdentity : body.state;
  } finally {
    process.env.DEMOS_CHAIN_IDENTITY = chainId;
  }
}

test("chain identity is a genesis block that answers as block zero, else a well-formed block one's predecessor", async () => {
  const originalFetch = globalThis.fetch;
  const genesisHash = "0a".repeat(32);
  try {
    assert.equal(await chainIdentityFor({ genesis: { number: 0, hash: ` ${genesisHash.toUpperCase()} ` } }, genesisHash), genesisHash);
    assert.equal(await chainIdentityFor({ genesis: { id: 0, hash: genesisHash } }, genesisHash), genesisHash, "the node's `id` numbers the block");
    assert.equal(await chainIdentityFor({ genesis: { hash: genesisHash } }, genesisHash), genesisHash);
    // A block that is not block zero, or has no hash, never names the chain.
    assert.equal(await chainIdentityFor({ genesis: { number: 3, hash: genesisHash } }), chainId);
    assert.equal(await chainIdentityFor({ genesis: { number: 0, hash: "  " } }), chainId);
    for (const first of [
      { status: "pending" },
      { number: 2 },
      { hash: undefined },
      { hash: "  " },
      { content: { timestamp: 1 } },
      { content: JSON.stringify({ previousHash: "", timestamp: 1 }) },
    ]) {
      assert.equal(await chainIdentityFor({ first }), "inclusion-pending", JSON.stringify(first));
    }
    // node2 may serve block one's content as a JSON string.
    assert.equal(await chainIdentityFor({ first: { content: JSON.stringify({ previousHash: chainId, timestamp: 1 }) } }), chainId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("every validator-signature entry must have the node's key and signature shape", async () => {
  const originalFetch = globalThis.fetch;
  const key = `0x${"aa".repeat(32)}`;
  const signature = `0x${"bb".repeat(64)}`;
  try {
    for (const [name, signatures] of [
      ["a malformed entry beside a good one", { [key]: signature, [`0x${"cc".repeat(32)}`]: "0x1234" }],
      ["a 63-hex key", { [`0x${"a".repeat(63)}`]: signature }],
      ["a 65-byte key", { [`0x${"a".repeat(66)}`]: signature }],
      ["a key without 0x", { ["aa".repeat(32)]: signature }],
      ["a 127-hex signature", { [key]: `0x${"b".repeat(127)}` }],
      ["a 129-hex signature", { [key]: `0x${"b".repeat(129)}` }],
      ["a non-string signature", { [key]: 7 }],
      ["a signature inside an array", { [key]: [signature] }],
      ["a key with a junk prefix", { [`x${key}`]: signature }],
      ["a key with a junk suffix", { [`${key}00`]: signature }],
      ["a signature with a junk prefix", { [key]: `x${signature}` }],
      ["a signature with a junk suffix", { [key]: `${signature}00` }],
    ] as const) {
      stubChain({ block: { validation_data: { signatures } } });
      const response = await POST(request(coordinates));
      assert.equal(response.status, 202, name);
      assert.equal((await response.json() as { state: string }).state, "inclusion-pending", name);
    }
    // Several well-formed entries, in either hex case, keep the node's shape.
    stubChain({ block: { validation_data: { signatures: { [key]: signature, [`0x${"CC".repeat(32)}`]: `0x${"DD".repeat(64)}` } } } });
    assert.equal((await POST(request(coordinates))).status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("native and transaction metadata must agree and bind the logical address, content and envelope", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [name, overrides] of [
      ["transaction metadata differs", { transactionMetadata: { ...metadata, note: "other" } }],
      ["native metadata missing", { nativeMetadata: undefined as never, transactionMetadata: metadata, dropNative: true }],
      ["another logical address", { nativeMetadata: { ...metadata, logicalAddress: "dacs1:other" }, transactionMetadata: { ...metadata, logicalAddress: "dacs1:other" } }],
      ["another content hash", { nativeMetadata: { ...metadata, contentHash: "0".repeat(64) }, transactionMetadata: { ...metadata, contentHash: "0".repeat(64) } }],
    ] as const) {
      const { dropNative, ...stub } = overrides as Parameters<typeof stubChain>[0] & { dropNative?: boolean };
      stubChain(stub);
      if (dropNative) {
        const stubbed = globalThis.fetch;
        globalThis.fetch = async (input, init) => init?.method === "POST" ? stubbed(input, init)
          : Response.json({ success: true, data: listing, owner, programName, storageAddress: anchorAddress });
      }
      const response = await POST(request(coordinates));
      assert.equal(response.status, 409, name);
      assert.equal((await response.json() as { state: string }).state, "inclusion-failed", name);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a by-hash write at another locator or with other content never stands in for this listing", async () => {
  const originalFetch = globalThis.fetch;
  const other = `stor-${"cd".repeat(20)}`;
  const otherHash = "ef".repeat(32);
  try {
    for (const [name, byHash] of [
      ["another locator", { content: { ...transaction.content, to: other, data: ["storageProgram", { ...write, storageAddress: other }] } }],
      ["other listing bytes", { content: { ...transaction.content, data: ["storageProgram", { ...write, data: { ...listing, terms: { other: true } } }] } }],
      ["another transaction's hash", { hash: otherHash }],
    ] as const) {
      // The block would carry either transaction, so only the by-hash match decides.
      stubChain({ history: false, byHash, block: { content: { timestamp: 1_786_360_000, ordered_transactions: [transactionHash, otherHash] } } });
      const response = await POST(request({ ...coordinates, transactionRef: transactionHash }));
      assert.equal(response.status, 202, name);
      const body = await response.json() as { state: string; confirmed: unknown };
      assert.equal(body.state, "inclusion-pending", name);
      assert.equal(body.confirmed, false, name);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a missed by-hash read falls back to newest history, paging down by transaction id", async () => {
  const originalFetch = globalThis.fetch;
  try {
    // node2 answers an unknown hash with `result: 400`; the write is on the second page.
    stubChain({
      byHashUnknown: true,
      historyPages: { latest: [transfer(12), transfer(11)], 10: [historyWrite(10, transactionHash)] },
    });
    const response = await POST(request({ ...coordinates, transactionRef: transactionHash }));
    assert.equal(response.status, 200);
    const body = await response.json() as { state: string; nodeObservation: Observation };
    assert.equal(body.state, "finality-unverified");
    assert.equal(body.nodeObservation.transactionRef, transactionHash);
    assert.deepEqual(historyRequests, [{ start: "latest", limit: 100 }, { start: 10, limit: 100 }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("history paging stops at the oldest transaction and refuses a page without a cursor", async () => {
  const originalFetch = globalThis.fetch;
  try {
    stubChain({ historyPages: { latest: [transfer(2), transfer(1)] } });
    const exhausted = await POST(request(coordinates));
    assert.equal(exhausted.status, 202);
    assert.equal((await exhausted.json() as { reason: string }).reason, "canonical transaction is not included");
    assert.deepEqual(historyRequests, [{ start: "latest", limit: 100 }], "transaction one is the end of history");

    for (const [name, page] of [
      ["no ids", [transfer(undefined)]],
      ["a negative id", [transfer(-1)]],
      ["a fractional id", [transfer(1.5)]],
    ] as const) {
      stubChain({ historyPages: { latest: [...page] } });
      const response = await POST(request(coordinates));
      assert.equal(response.status, 202, name);
      assert.match((await response.json() as { reason: string }).reason, /no valid cursor/, name);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a history write at another locator, with other bytes, or under another hash never stands in", async () => {
  const originalFetch = globalThis.fetch;
  const other = `stor-${"cd".repeat(20)}`;
  const impostors = {
    otherLocator: historyWrite(14, "a1".repeat(32), { to: other }),
    otherBytes: historyWrite(13, "a2".repeat(32), { data: { ...listing, terms: { other: true } } }),
    rewrite: historyWrite(12, "a3".repeat(32)),
  };
  // The block would carry any of them, so only the history match decides.
  const block = {
    content: {
      timestamp: 1_786_360_000,
      ordered_transactions: [transactionHash, ...Object.values(impostors).map((tx) => tx.hash)],
    },
  };
  try {
    // Without a browser transactionRef, the newest write of these exact bytes at this locator.
    stubChain({ block, historyPages: { latest: [impostors.otherLocator, impostors.otherBytes, historyWrite(10, transactionHash)] } });
    const plain = await POST(request(coordinates));
    assert.equal(plain.status, 200);
    assert.equal((await plain.json() as { nodeObservation: Observation }).nodeObservation.transactionRef, transactionHash);

    // With one, an identical rewrite under another hash is not the browser's write either.
    stubChain({
      block,
      byHashUnknown: true,
      historyPages: { latest: [impostors.otherLocator, impostors.otherBytes, impostors.rewrite, historyWrite(10, transactionHash)] },
    });
    const pinned = await POST(request({ ...coordinates, transactionRef: transactionHash }));
    assert.equal(pinned.status, 200);
    assert.equal((await pinned.json() as { nodeObservation: Observation }).nodeObservation.transactionRef, transactionHash);

    stubChain({ block, byHashUnknown: true, historyPages: { latest: Object.values(impostors) } });
    const none = await POST(request({ ...coordinates, transactionRef: transactionHash }));
    assert.equal(none.status, 202);
    assert.equal((await none.json() as { state: string }).state, "inclusion-pending");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a native readback that reports another storage address is a coordinate mismatch", async () => {
  const originalFetch = globalThis.fetch;
  try {
    stubChain({ native: { storageAddress: `stor-${"cd".repeat(20)}` } });
    const response = await POST(request(coordinates));
    assert.equal(response.status, 409);
    const body = await response.json() as { state: string; error: string };
    assert.equal(body.state, "inclusion-failed");
    assert.equal(body.error, "native anchor coordinates do not match");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a block timestamp already in milliseconds is carried unchanged", async () => {
  const originalFetch = globalThis.fetch;
  try {
    stubChain({ block: { content: { timestamp: 1_786_360_000_123, ordered_transactions: [transactionHash] } } });
    const response = await POST(request(coordinates));
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { nodeObservation: Observation }).nodeObservation.blockTimestamp, 1_786_360_000_123);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("only the pinned Demos deployment's report becomes an observation", async () => {
  const originalFetch = globalThis.fetch;
  const node2 = { ...cleanBuild, dirty: true, builtAt: "2026-10-14T16:45:24Z" };
  const confirm = async (overrides: Parameters<typeof stubChain>[0]) => {
    stubChain(overrides);
    const response = await POST(request(coordinates));
    return {
      status: response.status,
      body: await response.json() as { state: string; error?: string; confirmed?: unknown; nodeObservation?: Observation },
    };
  };
  try {
    for (const [name, nodeVersion, reason] of [
      ["a build with uncommitted changes", node2, /\+dirty@2026-10-14T16:45:24Z is not pinned/],
      ["another commit", { ...cleanBuild, commit: "0".repeat(40) }, /is not pinned/],
      ["no dirty flag", { ...cleanBuild, dirty: undefined }, /no build identity/],
      ["no build identity", null, /no build identity/],
    ] as const) {
      const { status, body } = await confirm({ nodeVersion });
      assert.equal(status, 409, name);
      assert.equal(body.confirmed, false, name);
      assert.equal(body.state, "inclusion-failed", name);
      assert.match(body.error ?? "", reason, name);
    }
    // An operator may pin exactly one observed dirty build, never dirty builds in general.
    process.env.DEMOS_NODE_BUILDS = `${pinnedCommit}+dirty@2026-10-14T16:45:24Z`;
    const pinnedDirty = await confirm({ nodeVersion: node2 });
    assert.equal(pinnedDirty.status, 200);
    assert.equal(pinnedDirty.body.nodeObservation?.nodeBuild, `${pinnedCommit}+dirty@2026-10-14T16:45:24Z`);
    assert.equal((await confirm({ nodeVersion: { ...node2, builtAt: "2026-10-15T00:00:00Z" } })).status, 409);
    assert.equal((await confirm({})).status, 409, "the clean build is not in an explicit list that omits it");
    delete process.env.DEMOS_NODE_BUILDS;
    // A node on another chain is never reported as the pinned one.
    process.env.DEMOS_CHAIN_IDENTITY = "aa".repeat(32);
    const otherChain = await confirm({});
    assert.equal(otherChain.status, 409);
    assert.match(otherChain.body.error ?? "", /not the pinned chain/);
  } finally {
    delete process.env.DEMOS_NODE_BUILDS;
    process.env.DEMOS_CHAIN_IDENTITY = chainId;
    globalThis.fetch = originalFetch;
  }
});

test("the release pins node2's chain and clean build by default", () => {
  delete process.env.DEMOS_CHAIN_IDENTITY;
  try {
    assert.equal(pinnedChainIdentity(), "83082fbb733d76475a33a9f52fe3700d667a976c2d46bef33a149f47057f7dd4");
  } finally {
    process.env.DEMOS_CHAIN_IDENTITY = chainId;
  }
  assert.equal(pinnedChainIdentity("  "), PINNED_DEMOS_CHAIN_IDENTITY);
  assert.deepEqual(pinnedNodeBuilds(undefined), [pinnedCommit]);
  assert.deepEqual(pinnedNodeBuilds(" , "), [pinnedCommit]);
  assert.deepEqual(pinnedNodeBuilds(`${pinnedCommit}, ${"1".repeat(40)}`), [pinnedCommit, "1".repeat(40)]);
  assert.equal(nodeBuildRejection({ nodeVersion: { commit: pinnedCommit.toUpperCase(), dirty: false } }, [pinnedCommit]),
    "Demos node reports no build identity");
});
