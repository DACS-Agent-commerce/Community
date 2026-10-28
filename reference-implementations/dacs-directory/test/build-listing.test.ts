import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { NextRequest } from "next/server";
import { canonicalize, contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";

import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
} from "@kynesyslabs/dacs/crypto";
import { MAX_STORAGE_RESPONSE_BYTES } from "../src/catalog/artifactLimits.js";
import { deriveStorageAddress, LIVE_STORAGE_SALT } from "../src/catalog/chain.js";
import { verifyListing } from "../src/catalog/listingVerification.js";
import { authenticateReadableListingArtifact } from "../vendor/dacs-sdk/dist/agent/discover.js";
import { PINNED_DEMOS_CHAIN_IDENTITY, PINNED_DEMOS_NODE_BUILDS } from "../src/catalog/nodeDeployment.js";
import { signedRailSnapshot } from "./signed-rail-snapshot.js";

const dataDir = mkdtempSync(join(tmpdir(), "dacs-build-listing-"));
process.env.DACS_DIRECTORY_DATA = join(dataDir, "directory.sqlite");
const { createBuildListingPost } = await import("../src/catalog/buildListing.js");
const POST = createBuildListingPost(signedRailSnapshot);

// The shipped PA-1 table is unsigned, so the route refuses every rail before
// these steps (rail-registry.test.ts); here a signed snapshot is modelled.
test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** node2's getNetworkInfo `nodeVersion` for the pinned commit. */
const cleanBuild = { commit: PINNED_DEMOS_NODE_BUILDS[0], dirty: false, builtAt: "2026-10-14T16:45:24Z" };
/**
 * Answer the deployment preflight (getNetworkInfo, then block zero's error and
 * block one's predecessor) as the pinned build and chain; null for other calls.
 */
function deploymentReply(
  init: RequestInit | undefined,
  nodeVersion: Record<string, unknown> = cleanBuild,
  chain = PINNED_DEMOS_CHAIN_IDENTITY,
): Response | null {
  if (init?.method !== "POST") return null;
  const call = (JSON.parse(String(init.body)) as { params?: Array<{ message?: string; data?: { blockNumber?: number } }> }).params?.[0];
  if (call?.message === "getNetworkInfo") return Response.json({ result: 200, response: { nodeVersion } });
  if (call?.message === "getBlockByNumber" && call.data?.blockNumber === 0) return Response.json({ result: 400, response: "error" });
  if (call?.message === "getBlockByNumber" && call.data?.blockNumber === 1) {
    return Response.json({
      result: 200,
      response: { id: 2, number: 1, status: "confirmed", hash: "12".repeat(32), content: { previousHash: chain, timestamp: 1 } },
    });
  }
  return null;
}

const seed = Uint8Array.from(Buffer.alloc(32, 12));
const privateKey = privateKeyFromSeed(seed);
const keyHex = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex");
const claim = `did:demos:agent:${keyHex}`;
const base = {
  claim,
  serviceId: "metered-ap2",
  name: "Metered AP2 service",
  description: "A metered service settled through an operator-gated AP2 provider.",
  rails: ["ap2:stripe-paymentintents"],
  delivery: ["deliver-storage-program"],
  pricing: {
    kind: "metered",
    amount: "0.02",
    currency: "USD",
    unit: "API call",
    minTotal: "1",
  },
};

const request = (body: Record<string, unknown>) => new NextRequest(
  "https://directory.example/api/dacs/build-listing",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  },
);

test("Listing signature decoding and verifier exceptions refuse transaction release", async (t) => {
  t.mock.method(Date, "now", () => 1_810_000_000_000);
  t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const deployment = deploymentReply(init);
    if (deployment) return deployment;
    const call = init?.body ? JSON.parse(String(init.body)).params?.[0]?.message : null;
    return Response.json({ result: 200, response: call === "searchStoragePrograms" ? [] : 0 });
  });
  const input = { ...base, serviceId: "signature-refusal" };
  const identity = await (await POST(request(input))).json();
  const authenticated = { ...input, listingVersion: identity.listingVersion, identityPresentedAt: identity.identityPresentedAt,
    identitySignature: Buffer.from(ed25519Sign(Buffer.from(identity.identityMessage), privateKey)).toString("hex") };
  const preview = await (await POST(request(authenticated))).json();
  assert.equal(preview.tx, null);
  const listingSignature = Buffer.from(ed25519Sign(Buffer.from(preview.message), privateKey)).toString("hex");
  const valid = await POST(request({ ...authenticated, listingSignature }));
  assert.equal(valid.status, 200);
  assert.ok((await valid.json()).tx, "allowed control: an authentic signature releases the transaction");
  for (const malformed of [null, {}, "", "ab", "z".repeat(128), `${listingSignature}junk`, "00".repeat(64)]) {
    const response = await POST(request({ ...authenticated, listingSignature: malformed }));
    assert.equal(response.status, 400, JSON.stringify(malformed));
    const body = await response.json();
    assert.ok(typeof body.error === "string" && body.error.length > 0);
    assert.equal(body.tx, undefined);
    assert.equal(body.listing, undefined);
  }
  const originalVerify = crypto.verify;
  let listingCalls = 0;
  const verifier = t.mock.method(crypto, "verify", (algorithm: null, data: Uint8Array,
    key: crypto.KeyObject, signature: Uint8Array) => {
    if (Buffer.from(data).toString("utf8").startsWith("dacs-listing:v1:")) {
      listingCalls++;
      throw new Error("Listing verifier failed");
    }
    return originalVerify(algorithm, data, key, signature);
  });
  syncBuiltinESMExports();
  try {
    const response = await POST(request({ ...authenticated, listingSignature }));
    assert.ok(listingCalls > 0, "the Listing verifier exception path was reached");
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.ok(typeof body.error === "string" && body.error.length > 0);
    assert.equal(body.tx, undefined);
    assert.equal(body.listing, undefined);
  } finally { verifier.mock.restore(); syncBuiltinESMExports(); }
});

test("publisher uses PA-1 rail resolution and signs the exact staged Listing before creating a transaction", async (t) => {
  const now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const identityResponse = await POST(request(base));
  assert.equal(identityResponse.status, 200);
  const identity = await identityResponse.json() as {
    identityMessage: string;
    identityPresentedAt: number;
    listingVersion: number;
  };
  const identitySignature = Buffer.from(
    ed25519Sign(Buffer.from(identity.identityMessage, "utf8"), privateKey),
  ).toString("hex");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const deployment = deploymentReply(init);
    if (deployment) return deployment;
    if (init?.method === "POST") {
      const rpc = JSON.parse(String(init.body)) as { params?: Array<{ message?: string }> };
      if (rpc.params?.[0]?.message === "searchStoragePrograms") {
        return Response.json({ result: 200, response: [] });
      }
      return new Response(JSON.stringify({ result: 200, response: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ success: false }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const response = await POST(request({
      ...base,
      listingVersion: identity.listingVersion,
      identityPresentedAt: identity.identityPresentedAt,
      identitySignature,
    }));
    assert.equal(response.status, 200);
    const preview = await response.json() as {
      listing: Record<string, unknown>;
      message: string;
      contentHash: string;
      logicalAddress: string;
      programName: string;
      exists: boolean;
      artifactProfile: string;
      publicationReady: boolean;
      railResolution: { disposition: string; reason: string; authorityBasis: string };
      payloadCapability: { disposition: string };
      tx: null;
    };
    assert.equal(preview.publicationReady, false);
    assert.equal(preview.artifactProfile, "dacs-v0.1");
    assert.equal(preview.exists, false);
    assert.deepEqual(preview.listing.requiredCapabilities, ["SR-2"]);
    assert.equal(preview.tx, null, "an unsigned preview must not contain a broadcastable transaction");
    // LP-6: publication proceeds only on `verified`, here from the modelled signed snapshot.
    assert.equal(preview.railResolution.disposition, "verified");
    assert.equal(preview.railResolution.authorityBasis, "pa1-in-code");
    assert.equal(preview.payloadCapability.disposition, "not-applicable");
    assert.deepEqual(preview.listing.pricing, {
      kind: "metered",
      unitPrice: { amount: "0.02", currency: "USD" },
      unit: "API call",
      minTotal: { amount: "1", currency: "USD" },
    });
    assert.deepEqual(preview.listing.acceptedRails, [{ railId: "ap2:stripe-paymentintents" }]);
    assert.deepEqual(
      (preview.listing.offering as Record<string, unknown>).deliverable,
      { kind: "storage-program", accessModel: "public" },
    );
    assert.deepEqual(preview.listing.pipeline, [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-agreement" },
      { kind: "pay-ap2", parameters: { rail: "ap2:stripe-paymentintents" } },
      { kind: "deliver-storage-program" },
    ]);

    const listingSignature = Buffer.from(
      ed25519Sign(Buffer.from(preview.message, "utf8"), privateKey),
    ).toString("hex");
    const finalResponse = await POST(request({
      ...base,
      listingVersion: identity.listingVersion,
      identityPresentedAt: identity.identityPresentedAt,
      identitySignature,
      listingSignature,
    }));
    assert.equal(finalResponse.status, 200);
    const built = await finalResponse.json() as {
      listing: Record<string, unknown>;
      contentHash: string;
      logicalAddress: string;
      programName: string;
      anchorAddress: string;
      exists: boolean;
      publicationReady: boolean;
      tx: { content: { nonce: number; data: [string, Record<string, unknown>] } };
    };
    assert.equal(built.publicationReady, true);
    assert.equal(built.contentHash, preview.contentHash);
    assert.equal(built.exists, false);
    assert.equal(built.logicalAddress, `dacs1:did%3Ademos%3Aagent%3A${keyHex}:metered-ap2:v1`);
    assert.ok(!built.programName.includes(":"), "the producer-held Demos name must be colon-free");
    assert.equal(built.programName, built.logicalAddress.replaceAll(":", "%3A"));
    assert.equal(built.tx.content.nonce, 1);
    assert.equal(built.tx.content.data[1].salt, "", "SDK #70 uses the live empty-salt convention");
    assert.deepEqual(built.tx.content.data[1].data, built.listing);
    assert.equal((built.tx.content.data[1].metadata as Record<string, unknown>).contentHash, built.contentHash);
    assert.equal(
      built.anchorAddress,
      deriveStorageAddress(`0x${keyHex}`, built.programName, 1, LIVE_STORAGE_SALT),
    );
    assert.equal(built.contentHash.length, 64);
    assert.deepEqual(built.tx, {
      content: { type: "storageProgram", from: `0x${keyHex}`, to: built.anchorAddress, amount: 0,
        data: ["storageProgram", { operation: "CREATE_STORAGE_PROGRAM", storageAddress: built.anchorAddress,
          programName: built.programName, encoding: "json", data: built.listing,
          metadata: { logicalAddress: built.logicalAddress, contentHash: built.contentHash, envelopeHash: sha256Hex(canonicalize(built.listing)) },
          acl: { mode: "public" }, salt: "", storageLocation: "onchain" }],
        nonce: 1, timestamp: now, transaction_fee: { network_fee: 0, rpc_fee: 0, additional_fee: 0, rpc_address: null } },
      signature: null, hash: "", status: "", blockNumber: null,
    });

    assert.ok(await verifyListing(built.listing));
    const sig6 = /^[A-Za-z0-9_-]{86}$/;
    assert.match((built.listing.signature as { value: string }).value, sig6, "CORE §B.7 SIG-6 base64url");
    const identityBundle = (built.listing.seller as { identity: { presentation: { signatures: Array<{ signature: string }> } } }).identity;
    assert.match(identityBundle.presentation.signatures[0].signature, sig6);
    assert.ok(await authenticateReadableListingArtifact(built.listing, {
      verify: (bytes, signature, publicKey) => ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
    }), "an SDK buyer authenticates the published Listing");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("publisher refuses an invalid occupied version without skipping to the next version", async () => {
  const identity = await (await POST(request(base))).json() as { identityMessage: string; identityPresentedAt: number; listingVersion: number };
  const walletHex = (message: string) =>
    Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKey)).toString("hex");
  const finalInput = {
    ...base,
    serviceId: "invalid-occupied-version",
    listingVersion: identity.listingVersion,
    identityPresentedAt: identity.identityPresentedAt,
    identitySignature: walletHex(identity.identityMessage),
  };
  let occupied: { address: string; name: string; data: Record<string, unknown> } | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const deployment = deploymentReply(init);
    if (deployment) return deployment;
    if (init?.method === "POST") {
      const rpc = JSON.parse(String(init.body)) as { params?: Array<{ message?: string; data?: { query?: string } }> };
      if (rpc.params?.[0]?.message === "searchStoragePrograms") {
        return Response.json({
          result: 200,
          response: occupied && rpc.params[0].data?.query === occupied.name
            ? [{ storageAddress: occupied.address, programName: occupied.name }]
            : [],
        });
      }
      return Response.json({ result: 200, response: 0 });
    }
    return occupied && String(input).endsWith(occupied.address)
      ? Response.json({ success: true, data: occupied.data, owner: `0x${keyHex}`, programName: occupied.name })
      : new Response(null, { status: 404 });
  };
  type Built = {
    listing: Record<string, unknown>;
    message: string;
    logicalAddress: string;
    programName: string;
    anchorAddress: string;
    exists: boolean;
    tx: unknown;
  };
  try {
    const v1Preview = await (await POST(request(finalInput))).json() as Built;
    const v1 = await (await POST(request({ ...finalInput, listingSignature: walletHex(v1Preview.message) }))).json() as Built;
    // What the earlier browser publisher anchored: the same bytes with a raw hex signature value.
    const signature = v1.listing.signature as Record<string, unknown> & { value: string };
    occupied = {
      address: v1.anchorAddress,
      name: v1.programName,
      data: { ...v1.listing, signature: { ...signature, value: Buffer.from(signature.value, "base64url").toString("hex") } },
    };
    assert.equal(await verifyListing(occupied.data), null);

    for (const input of [finalInput, { ...finalInput, listingSignature: walletHex(v1Preview.message) }]) {
      const response = await POST(request(input));
      assert.equal(response.status, 409);
      const body = await response.json();
      assert.match(body.error, /choose a new Service ID/);
      assert.equal(body.tx, undefined, "no transaction can skip the occupied v1");
      assert.equal(body.listing, undefined, "no v2 artifact is issued for signing");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("publisher recovers an immutable owner-bound listing instead of creating a duplicate", async () => {
  const identityResponse = await POST(request(base));
  const identity = await identityResponse.json() as { identityMessage: string; identityPresentedAt: number; listingVersion: number };
  const identitySignature = Buffer.from(
    ed25519Sign(Buffer.from(identity.identityMessage, "utf8"), privateKey),
  ).toString("hex");
  const finalInput = { ...base, serviceId: "immutable-recovery", listingVersion: identity.listingVersion,
    identityPresentedAt: identity.identityPresentedAt, identitySignature };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const deployment = deploymentReply(init);
    if (deployment) return deployment;
    if (init?.method === "POST") {
      const rpc = JSON.parse(String(init.body)) as { params?: Array<{ message?: string }> };
      return rpc.params?.[0]?.message === "searchStoragePrograms"
        ? Response.json({ result: 200, response: [] })
        : Response.json({ result: 200, response: 6 });
    }
    return Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
  };
  try {
    const previewResponse = await POST(request(finalInput));
    const preview = await previewResponse.json() as { message: string };
    const listingSignature = Buffer.from(
      ed25519Sign(Buffer.from(preview.message, "utf8"), privateKey),
    ).toString("hex");
    const builtResponse = await POST(request({ ...finalInput, listingSignature }));
    assert.equal(builtResponse.status, 200);
    const built = await builtResponse.json() as {
      listing: Record<string, unknown>;
      message: string;
      contentHash: string;
      programName: string;
      anchorAddress: string;
    };
    const signedListing = built.listing;

    globalThis.fetch = async (input, init) => {
      if (init?.method === "POST") {
        const rpc = JSON.parse(String(init.body)) as { params?: Array<{ message?: string }> };
        assert.equal(rpc.params?.[0]?.message, "searchStoragePrograms", "recovery must not request a fresh write nonce");
        return Response.json({
          result: 200,
          response: [{ storageAddress: built.anchorAddress, programName: built.programName }],
        });
      }
      assert.match(String(input), new RegExp(`${built.anchorAddress}$`));
      return Response.json({
        success: true,
        data: signedListing,
        owner: `0x${keyHex}`,
        programName: built.programName,
      });
    };

    const recoveredResponse = await POST(request({ ...finalInput, name: "A different requested name" }));
    assert.equal(recoveredResponse.status, 200);
    const recovered = await recoveredResponse.json() as {
      exists: boolean;
      tx: unknown;
      message?: string;
      listing: Record<string, unknown>;
      contentHash: string;
      anchorAddress: string;
      registration: { displayName: string };
    };
    assert.equal(recovered.exists, true);
    assert.equal(recovered.tx, null);
    assert.equal(recovered.message, undefined);
    assert.equal(recovered.anchorAddress, built.anchorAddress);
    assert.equal(recovered.contentHash, built.contentHash);
    assert.deepEqual(recovered.listing, signedListing);
    assert.equal(recovered.registration.displayName, base.name, "recovery keeps the occupied artifact's display name");

    const previousImports = process.env.DACS_HISTORICAL_LISTING_IMPORTS;
    (signedListing.signature as { value: string }).value = listingSignature;
    try {
      delete process.env.DACS_HISTORICAL_LISTING_IMPORTS;
      assert.equal((await POST(request(finalInput))).status, 409, "unproven hex cannot enter recovery");
      process.env.DACS_HISTORICAL_LISTING_IMPORTS = JSON.stringify({ [built.anchorAddress]: {
        encoding: "lowercase-hex", sellerPrimaryClaim: claim, listingId: built.listing.listingId,
        listingVersion: built.listing.listingVersion, contentHash: built.contentHash,
      } });
      for (let repeat = 0; repeat < 2; repeat++) {
        const historical = await POST(request(finalInput));
        assert.equal(historical.status, 200);
        const value = await historical.json();
        assert.equal(value.exists, true);
        assert.equal(value.tx, null, "repeat recovery never constructs another transaction");
        assert.equal(value.anchorAddress, built.anchorAddress);
        assert.equal(value.contentHash, built.contentHash);
        assert.deepEqual(value.listing, signedListing, "original hex bytes survive recovery");
      }
      const { POST: confirm } = await import("../app/api/dacs/confirm-listing/route.js");
      const confirmed = await confirm(request({ transactionRef: "cd".repeat(32), anchorAddress: built.anchorAddress, programName: built.programName,
        contentHash: built.contentHash, sellerClaim: claim, listingId: built.listing.listingId,
        listingVersion: built.listing.listingVersion }));
      // Recovered history passes confirm-listing's verification; registration
      // still waits on finality this Directory cannot verify (DACS-1 LP-1).
      const confirmation = await confirmed.json() as { confirmed: boolean; state: string };
      assert.notEqual(confirmation.state, "verification-failed", "recovered history passes confirm-listing's verification");
      assert.equal(confirmation.confirmed, false);
    } finally {
      if (previousImports === undefined) delete process.env.DACS_HISTORICAL_LISTING_IMPORTS;
      else process.env.DACS_HISTORICAL_LISTING_IMPORTS = previousImports;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("publisher prepares no transaction unless the node is the pinned deployment", async () => {
  const identity = await (await POST(request(base))).json() as { identityMessage: string; identityPresentedAt: number; listingVersion: number };
  const hexSig = (message: string) =>
    Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKey)).toString("hex");
  const finalInput = {
    ...base,
    serviceId: "deployment-pin",
    listingVersion: identity.listingVersion,
    identityPresentedAt: identity.identityPresentedAt,
    identitySignature: hexSig(identity.identityMessage),
  };
  const dirty = { ...cleanBuild, dirty: true };
  let node: { nodeVersion: Record<string, unknown>; chain: string; down?: boolean } = { nodeVersion: cleanBuild, chain: PINNED_DEMOS_CHAIN_IDENTITY };
  let calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    if (init?.method !== "POST") return new Response(null, { status: 404 });
    const message = (JSON.parse(String(init.body)) as { params?: Array<{ message?: string }> }).params?.[0]?.message ?? "";
    calls.push(message);
    if (node.down && message === "getNetworkInfo") return new Response("unavailable", { status: 503 });
    const deployment = deploymentReply(init, node.nodeVersion, node.chain);
    if (deployment) return deployment;
    return Response.json({ result: 200, response: message === "searchStoragePrograms" ? [] : 0 });
  };
  const listingSignature = async () => {
    const preview = await (await POST(request(finalInput))).json() as { message: string; tx: unknown };
    assert.equal(preview.tx, null);
    return hexSig(preview.message);
  };
  try {
    for (const [name, state, status, error] of [
      // node2 today: the pinned commit with uncommitted changes.
      ["dirty build", { nodeVersion: dirty, chain: PINNED_DEMOS_CHAIN_IDENTITY }, 409, /\+dirty@2026-10-14T16:45:24Z is not pinned; no transaction was prepared/],
      ["another commit", { nodeVersion: { ...cleanBuild, commit: "f".repeat(40) }, chain: PINNED_DEMOS_CHAIN_IDENTITY }, 409, /is not pinned/],
      ["no build identity", { nodeVersion: {}, chain: PINNED_DEMOS_CHAIN_IDENTITY }, 409, /reports no build identity/],
      ["another chain", { nodeVersion: cleanBuild, chain: "aa".repeat(32) }, 409, /not the pinned chain/],
      ["unreadable node", { nodeVersion: cleanBuild, chain: PINNED_DEMOS_CHAIN_IDENTITY, down: true }, 503, /could not read the Demos node's build and chain \(getNetworkInfo transport failed\)/],
    ] as const) {
      node = state;
      const signature = await listingSignature();
      calls = [];
      const response = await POST(request({ ...finalInput, listingSignature: signature }));
      assert.equal(response.status, status, name);
      const body = await response.json() as { error?: string; tx?: unknown };
      assert.match(String(body.error), error, name);
      assert.equal(body.tx, undefined, `${name}: no broadcastable transaction`);
      assert.ok(calls.includes("getNetworkInfo"), name);
      assert.ok(!calls.includes("getAddressNonce"), `${name}: no write nonce is requested`);
    }
    // An operator who pins that exact dirty build gets the transaction.
    process.env.DEMOS_NODE_BUILDS = `${cleanBuild.commit}+dirty@${cleanBuild.builtAt}`;
    node = { nodeVersion: dirty, chain: PINNED_DEMOS_CHAIN_IDENTITY };
    const pinned = await POST(request({ ...finalInput, listingSignature: await listingSignature() }));
    assert.equal(pinned.status, 200);
    assert.ok((await pinned.json() as { tx?: unknown }).tx);
  } finally {
    delete process.env.DEMOS_NODE_BUILDS;
    globalThis.fetch = originalFetch;
  }
});

test("publisher rejects a metered listing without its deterministic unit", async () => {
  const response = await POST(request({
    ...base,
    pricing: { ...base.pricing, unit: "" },
  }));
  assert.equal(response.status, 400);
  assert.match(String((await response.json()).error), /metered pricing needs a unit/);
});

test("publisher refuses a new write when existing-publication lookup is indeterminate", async () => {
  const identityResponse = await POST(request(base));
  const identity = await identityResponse.json() as { identityMessage: string; identityPresentedAt: number; listingVersion: number };
  const identitySignature = Buffer.from(
    ed25519Sign(Buffer.from(identity.identityMessage, "utf8"), privateKey),
  ).toString("hex");

  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("temporarily unavailable", { status: 503 });
  };
  try {
    const response = await POST(request({
      ...base,
      listingVersion: identity.listingVersion,
      identityPresentedAt: identity.identityPresentedAt,
      identitySignature,
    }));
    assert.equal(response.status, 503);
    assert.match(String((await response.json()).error), /could not safely determine/);
    assert.equal(calls, 1, "an indeterminate search must not fall through to a nonce request");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("publisher returns no transaction for a listing signature that does not verify", async () => {
  const input = { ...base, serviceId: "invalid-listing-signatures" };
  const identity = await (await POST(request(input))).json() as { identityMessage: string; identityPresentedAt: number; listingVersion: number };
  const otherKey = privateKeyFromSeed(Uint8Array.from(Buffer.alloc(32, 13)));
  const hexSig = (message: string, key = privateKey) =>
    Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), key)).toString("hex");
  const finalInput = {
    ...input,
    listingVersion: identity.listingVersion,
    identityPresentedAt: identity.identityPresentedAt,
    identitySignature: hexSig(identity.identityMessage),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => init?.method === "POST"
    ? Response.json({ result: 200, response: JSON.parse(String(init.body)).params?.[0]?.message === "searchStoragePrograms" ? [] : 0 })
    : new Response(null, { status: 404 });
  try {
    const preview = await (await POST(request(finalInput))).json() as { message: string; tx: unknown };
    assert.equal(preview.tx, null);
    for (const [name, listingSignature] of Object.entries({
      "garbage 64 bytes": "ab".repeat(64),
      "signature over another message": hexSig(`${preview.message}0`),
      "signature by another key": hexSig(preview.message, otherKey),
    })) {
      const response = await POST(request({ ...finalInput, listingSignature }));
      assert.equal(response.status, 400, name);
      const body = await response.json() as { tx?: unknown };
      assert.equal(body.tx, undefined, `${name}: no broadcastable transaction`);
    }
    // A signature that is not a string is a client error, never an unhandled 500.
    for (const listingSignature of [7, null, ["ab".repeat(64)], { value: "ab".repeat(64) }]) {
      const response = await POST(request({ ...finalInput, listingSignature }));
      assert.equal(response.status, 400, JSON.stringify(listingSignature));
      assert.equal((await response.json() as { tx?: unknown }).tx, undefined);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("publisher withholds a create when the fallback search cannot establish absence", async () => {
  const identityResponse = await POST(request(base));
  const identity = await identityResponse.json() as { identityMessage: string; identityPresentedAt: number; listingVersion: number };
  const identitySignature = Buffer.from(
    ed25519Sign(Buffer.from(identity.identityMessage, "utf8"), privateKey),
  ).toString("hex");
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const rpc = JSON.parse(String(init?.body));
    methods.push(rpc.method);
    if (rpc.method === "nodeCall" && rpc.params[0].message === "searchStoragePrograms") {
      return Response.json({ result: 200, response: '{ error: "Unknown message"}' });
    }
    if (rpc.method === "gcr_routine") return Response.json({ result: 200, response: [] });
    // Make a nonce request succeed so a regression fails on the HTTP result.
    return Response.json({ result: 200, response: 6 });
  };
  try {
    const response = await POST(request({ ...base, listingVersion: identity.listingVersion,
      identityPresentedAt: identity.identityPresentedAt, identitySignature }));
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.match(body.error, /could not safely determine.*cannot establish absence/);
    assert.equal(body.tx, undefined);
    assert.deepEqual(methods, ["nodeCall", "gcr_routine"], "no fresh nonce may be requested after an incomplete lookup");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a configured resolver decides occupancy after the pinned node's fallback search", async (t) => {
  t.mock.method(Date, "now", () => 1_810_000_000_000);
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const deployment = deploymentReply(init);
    if (deployment) return deployment;
    const rpc = JSON.parse(String(init?.body));
    calls.push(rpc.method === "nodeCall" ? rpc.params[0].message : rpc.method);
    if (rpc.params?.[0]?.message === "searchStoragePrograms") {
      return Response.json({ result: 200, response: '{ error: "Unknown message"}' });
    }
    if (rpc.method === "gcr_routine") return Response.json({ result: 200, response: [] });
    return Response.json({ result: 200, response: 6 });
  });
  let resolved = 0;
  const completeEmpty = createBuildListingPost(signedRailSnapshot, async (logicalAddress, chainIdentity) => {
    resolved++;
    return { status: "complete", logicalAddress, chainIdentity, nativeAddresses: [] };
  });
  const uncertain = createBuildListingPost(signedRailSnapshot, async () => ({ status: "indeterminate", reason: "history index is incomplete" }));
  const input = { ...base, serviceId: "pinned-fallback-resolver" };
  const identity = await (await completeEmpty(request(input))).json();
  const authenticated = { ...input, listingVersion: identity.listingVersion, identityPresentedAt: identity.identityPresentedAt,
    identitySignature: Buffer.from(ed25519Sign(Buffer.from(identity.identityMessage), privateKey)).toString("hex") };
  const preview = await completeEmpty(request(authenticated));
  assert.equal(preview.status, 200);
  const previewBody = await preview.json();
  assert.equal(previewBody.tx, null);
  const listingSignature = Buffer.from(ed25519Sign(Buffer.from(previewBody.message), privateKey)).toString("hex");
  const withheld = await uncertain(request({ ...authenticated, listingSignature }));
  assert.equal(withheld.status, 503);
  const withheldBody = await withheld.json();
  assert.match(withheldBody.error, /history index is incomplete/, "the resolver's own cause is reported");
  assert.equal(withheldBody.tx, undefined);
  assert.equal(calls.includes("getAddressNonce"), false);
  const created = await completeEmpty(request({ ...authenticated, listingSignature }));
  assert.equal(created.status, 200);
  assert.ok((await created.json()).tx);
  assert.equal(resolved, 2);
  assert.ok(calls.includes("gcr_routine"), "the pinned node's fallback search answered first");
});

test("LP-3 listing versions are allocated per listingId", async () => {
  const store = await import("../src/catalog/store.js");
  const summary = (listingId: string, version: number) => ({
    listingId, version, contentHash: "0".repeat(64), anchor: { kind: "storage-program", locator: `stor-${"0".repeat(40)}` },
    seller: { primaryClaim: claim }, offering: { title: "", description: "", category: "services.other", tags: [] },
    pricing: {}, status: "active",
  });
  store.saveCatalog({
    catalogVersion: "1",
    generatedAt: 1,
    sellers: [{ primaryClaim: claim, listings: [summary("another-listing", 5), summary(base.serviceId, 2)] }],
  } as never);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => init?.method === "POST"
    ? Response.json({ result: 200, response: JSON.parse(String(init.body)).params?.[0]?.message === "searchStoragePrograms" ? [] : 0 })
    : new Response(null, { status: 404 });
  try {
    /** The version the first step offers, and the one the preview then builds. */
    const preview = async (serviceId: string) => {
      const identity = await (await POST(request({ ...base, serviceId }))).json() as {
        identityMessage: string; identityPresentedAt: number; listingVersion: number;
      };
      const built = await (await POST(request({ ...base, serviceId, listingVersion: identity.listingVersion,
        identityPresentedAt: identity.identityPresentedAt, identitySignature: walletSignature(identity.identityMessage) }))).json() as {
        listing: { listingVersion: number };
      };
      return { offered: identity.listingVersion, built: built.listing.listingVersion };
    };
    assert.deepEqual(await preview(base.serviceId), { offered: 3, built: 3 }, "the next version of this listingId");
    assert.deepEqual(await preview("fresh-listing"), { offered: 1, built: 1 }, "another listingId's versions are not inherited");
  } finally {
    globalThis.fetch = originalFetch;
    store.saveCatalog({ catalogVersion: "1", generatedAt: 2, sellers: [] });
  }
});

test("publisher emits canonical DEM and x402 registry IDs and rejects phase-name aliases", async () => {
  for (const alias of ["pay-dem", "pay-x402"]) {
    const response = await POST(request({ ...base, rails: [alias] }));
    assert.equal(response.status, 400);
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const call = JSON.parse(String(init?.body)).params?.[0];
    return Response.json({ result: 200, response: call?.message === "searchStoragePrograms" ? [] : 0 });
  };
  try {
    for (const [railId, phaseKind, currency] of [["demos-native:DEM", "pay-dem", "DEM"], ["x402:default", "pay-x402", "USDC"]]) {
      const body = { ...base, serviceId: `registry-${phaseKind}`, rails: [railId], pricing: { kind: "fixed", amount: "1", currency } };
      const stage = await POST(request(body));
      assert.equal(stage.status, 200);
      const identity = await stage.json() as { identityMessage: string; identityPresentedAt: number; listingVersion: number };
      const response = await POST(request({ ...body, listingVersion: identity.listingVersion, identityPresentedAt: identity.identityPresentedAt,
        identitySignature: Buffer.from(ed25519Sign(Buffer.from(identity.identityMessage), privateKey)).toString("hex") }));
      assert.equal(response.status, 200, await response.clone().text());
      const built = await response.json() as { listing: { acceptedRails: unknown; pipeline: unknown[] } };
      assert.deepEqual(built.listing.acceptedRails, [{ railId }]);
      assert.deepEqual(built.listing.pipeline[2], { kind: phaseKind, parameters: { rail: railId } });
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("publisher rejects fractional percentages cleanly under its integer profile", async () => {
  for (const [minPct, maxPct] of [[2.5, 20], [2, 2.5]]) {
    const response = await POST(request({ ...base, pricing: { kind: "negotiable", amount: "10", currency: "DEM", minPct, maxPct } }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /integer/);
  }
});

test("publication rejects lone high/low surrogate keys and values and accepts a valid pair", async () => {
  for (const surrogate of ["\ud800", "\udfff"]) {
    for (const extra of [{ description: surrogate }, { [surrogate]: "extension" }]) {
      const response = await POST(request({ ...base, ...extra }));
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /invalid Unicode/);
    }
  }
  const response = await POST(request({ ...base, name: "Service \ud83d\ude00", ["\ud83d\ude00"]: "valid" }));
  assert.equal(response.status, 200);
  assert.ok((await response.json()).identityMessage);
});

const walletSignature = (message: string, key = privateKey) =>
  Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), key)).toString("hex");

/**
 * Run the staged calls (identity, preview, signed) for `input`, returning the final response, or the
 * preview's when it already ends the flow (a recovered or refused occupied version has no message to sign).
 */
async function publishAs(input: Record<string, unknown>, key = privateKey): Promise<Response> {
  const identity = await (await POST(request(input))).json() as { identityMessage: string; identityPresentedAt: number; listingVersion: number };
  const authenticated = { ...input, listingVersion: identity.listingVersion,
    identityPresentedAt: identity.identityPresentedAt, identitySignature: walletSignature(identity.identityMessage, key) };
  const previewResponse = await POST(request(authenticated));
  const preview = await previewResponse.clone().json() as { message?: string };
  if (preview.message === undefined) return previewResponse;
  return POST(request({ ...authenticated, listingSignature: walletSignature(preview.message, key) }));
}

test("publisher prepares no transaction unless the account nonce is read within its bounds", async (t) => {
  // Each deadline is a controllable signal, so a body that stalls until the deadline fires needs no real wait.
  const deadlines = new Map<AbortSignal, AbortController>();
  const deadlineLengths: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    const controller = new AbortController();
    deadlines.set(controller.signal, controller);
    deadlineLengths.push(ms);
    return controller.signal;
  });
  const timedOut = () => new DOMException("The operation timed out.", "TimeoutError");
  type NonceReply = (signal: AbortSignal | undefined) => Response | Promise<Response>;
  let nonceReply: NonceReply = () => Response.json({ result: 200, response: 0 });
  const nonceSignalsLive: boolean[] = [];
  t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const deployment = deploymentReply(init);
    if (deployment) return deployment;
    const call = init?.body ? JSON.parse(String(init.body)).params?.[0]?.message : null;
    if (call !== "getAddressNonce") return Response.json({ result: 200, response: [] });
    const signal = init?.signal ?? undefined;
    nonceSignalsLive.push(signal instanceof AbortSignal && !signal.aborted && deadlines.has(signal));
    return nonceReply(signal);
  });
  const input = { ...base, serviceId: "nonce-bounds" };
  // Each successful control prepares its own Listing: a prepared version is never created again.
  const nonceOf = async (serviceId: string) =>
    (await (await publishAs({ ...input, serviceId })).json() as { tx: { content: { nonce: number } } }).tx.content.nonce;
  assert.equal(await nonceOf("nonce-bounds-first"), 1, "allowed control: a valid nonce releases the transaction");
  nonceReply = () => Response.json({ result: 200, response: Number.MAX_SAFE_INTEGER - 1 });
  assert.equal(await nonceOf("nonce-bounds-max"), Number.MAX_SAFE_INTEGER, "the largest nonce whose successor stays exact");
  const refusals: Array<[string, NonceReply, RegExp]> = [
    ["node refusal", () => new Response("unavailable", { status: 503 }), /HTTP 503/],
    ["node timeout", () => { throw timedOut(); }, /did not answer in time/],
    ["unreachable node", () => { throw new TypeError("fetch failed"); }, /could not be reached/],
    ["oversized reply", () => Response.json({ result: 200, response: 0, padding: "x".repeat(MAX_STORAGE_RESPONSE_BYTES) }), /byte limit/],
    ["non-JSON reply", () => new Response("not json"), /not valid JSON/],
    ["body stalls until the deadline", (signal) => new Response(new ReadableStream({ pull: () => new Promise<void>((_, reject) => {
      const deadline = signal && deadlines.get(signal);
      if (!signal || !deadline) return reject(new Error("the nonce read has no deadline"));
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      deadline.abort(timedOut());
    }) })), /did not answer in time/],
    ["reply without a body", () => new Response(null), /could not be read/],
    ["error result", () => Response.json({ result: 500, response: 0 }), /result 500/],
    ["object result", () => Response.json({ result: { toString: null }, response: 0 }), /the node returned an unexpected result/],
    ["null nonce", () => Response.json({ result: 200, response: null }), /invalid account nonce/],
    ["missing nonce", () => Response.json({ result: 200 }), /invalid account nonce/],
    ["string nonce", () => Response.json({ result: 200, response: "7" }), /invalid account nonce/],
    ["negative nonce", () => Response.json({ result: 200, response: -1 }), /invalid account nonce/],
    ["fractional nonce", () => Response.json({ result: 200, response: 1.5 }), /invalid account nonce/],
    ["overflowing nonce", () => Response.json({ result: 200, response: Number.MAX_SAFE_INTEGER }), /invalid account nonce/],
  ];
  for (const [name, reply, error] of refusals) {
    nonceReply = reply;
    const response = await publishAs({ ...input, serviceId: `nonce-bounds-${name.replace(/[^a-z]+/g, "-")}` });
    assert.equal(response.status, 503, name);
    const body = await response.json() as { error?: string; tx?: unknown; listing?: unknown };
    assert.match(String(body.error), error, name);
    assert.match(String(body.error), /no transaction was prepared/, name);
    assert.equal(body.tx, undefined, `${name}: no broadcastable transaction`);
    assert.equal(body.listing, undefined, name);
  }
  assert.ok(nonceSignalsLive.length > refusals.length && nonceSignalsLive.every(Boolean),
    "every nonce read carries its own live deadline");
  assert.ok(deadlineLengths.includes(15_000), "the nonce deadline is 15 seconds");
});

test("with the real SDK, an exact signed repeat after empty name indexes and advancing nonces gets the saved transaction, not a second create", async (t) => {
  t.mock.method(Date, "now", () => 1_810_000_000_000);
  let nonceReads = 0;
  t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const deployment = deploymentReply(init);
    if (deployment) return deployment;
    const call = init?.body ? JSON.parse(String(init.body)).params?.[0]?.message : null;
    return Response.json({ result: 200, response: call === "searchStoragePrograms" ? [] : nonceReads++ });
  });
  const input = { ...base, serviceId: "durable-preparation" };
  const identity = await (await POST(request(input))).json() as { identityMessage: string; identityPresentedAt: number; listingVersion: number };
  const authenticated = { ...input, listingVersion: identity.listingVersion,
    identityPresentedAt: identity.identityPresentedAt, identitySignature: walletSignature(identity.identityMessage) };
  const preview = await (await POST(request(authenticated))).json() as { message: string };
  const signed = { ...authenticated, listingSignature: walletSignature(preview.message) };
  const first = await POST(request(signed));
  assert.equal(first.status, 200);
  const prepared = await first.json() as { anchorAddress: string; tx: unknown };
  const retry = await POST(request(signed));
  assert.equal(retry.status, 200);
  const body = await retry.json() as { anchorAddress: string; tx: unknown };
  assert.equal(body.anchorAddress, prepared.anchorAddress);
  assert.equal(JSON.stringify(body.tx), JSON.stringify(prepared.tx), "the saved bytes, not a rebuilt transaction");
  assert.equal(nonceReads, 1);
});

test("publisher refuses to recover an occupied program that holds another seller, listing or version", async (t) => {
  const otherSeed = Uint8Array.from(Buffer.alloc(32, 15));
  const otherKey = privateKeyFromSeed(otherSeed);
  const otherHex = Buffer.from(rawPublicKey(publicKeyFromSeed(otherSeed))).toString("hex");
  let occupied: { address: string; name: string; data: Record<string, unknown>; owner: string } | undefined;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const deployment = deploymentReply(init);
    if (deployment) return deployment;
    if (init?.method === "POST") {
      const rpc = JSON.parse(String(init.body)) as { params?: Array<{ message?: string; data?: { query?: string } }> };
      return Response.json({
        result: 200,
        response: rpc.params?.[0]?.message !== "searchStoragePrograms" ? 0
          : occupied && rpc.params[0].data?.query === occupied.name ? [{ storageAddress: occupied.address, programName: occupied.name }] : [],
      });
    }
    return occupied && String(input).endsWith(occupied.address)
      ? Response.json({ success: true, data: occupied.data, owner: occupied.owner, programName: occupied.name })
      : new Response(null, { status: 404 });
  });
  const input = { ...base, serviceId: "occupied-recovery" };
  const own = await (await publishAs(input)).json() as { listing: Record<string, unknown>; anchorAddress: string; programName: string };
  const otherListing = (await (await publishAs({ ...input, serviceId: "another-listing" })).json() as { listing: Record<string, unknown> }).listing;
  const otherSeller = (await (await publishAs({ ...input, claim: `did:demos:agent:${otherHex}` }, otherKey)).json() as { listing: Record<string, unknown> }).listing;
  const unsigned = { ...own.listing };
  delete unsigned.signature;
  const nextVersion = { ...unsigned, listingVersion: 2 };
  const nextVersionSignature = ed25519Sign(Buffer.from(`dacs-listing:v1:${contentHash(nextVersion)}`, "utf8"), privateKey);
  const signedNextVersion = {
    ...nextVersion,
    signature: { ...(own.listing.signature as Record<string, unknown>), value: Buffer.from(nextVersionSignature).toString("base64url") },
  };
  const occupy = (data: Record<string, unknown>) => {
    occupied = { address: own.anchorAddress, name: own.programName, data, owner: `0x${keyHex}` };
  };
  occupy(own.listing);
  const recovered = await publishAs(input);
  assert.equal(recovered.status, 200, "allowed control: this seller's own version is recovered");
  assert.equal((await recovered.json() as { exists: boolean }).exists, true);
  for (const [name, data] of [
    ["another listing ID", otherListing],
    ["another seller", otherSeller],
    ["another version", signedNextVersion],
  ] as const) {
    occupy(data);
    const response = await publishAs(input);
    assert.equal(response.status, 409, name);
    const body = await response.json() as { error?: string; tx?: unknown; listing?: unknown };
    assert.match(String(body.error), /choose a new Service ID/, name);
    assert.equal(body.tx, undefined, name);
    assert.equal(body.listing, undefined, name);
  }
});

test("browser publisher refuses attested payloads before asking for a wallet signature", async () => {
  const response = await POST(request({ ...base, delivery: ["deliver-attested-payload"] }));
  assert.equal(response.status, 409);
  const body = await response.json() as { error: string; identityMessage?: string };
  assert.match(body.error, /cannot prove.*production capability/i);
  assert.equal(body.identityMessage, undefined);
});

test("a signed retry that names its version resolves it after the catalog has indexed it", async () => {
  const store = await import("../src/catalog/store.js");
  const input = { ...base, serviceId: "replay-after-index" };
  let published: { anchorAddress: string; programName: string; listing: Record<string, unknown> } | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const deployment = deploymentReply(init);
    if (deployment) return deployment;
    if (init?.method === "POST") {
      const message = JSON.parse(String(init.body)).params?.[0]?.message;
      return Response.json({ result: 200, response: message !== "searchStoragePrograms" ? 0
        : published ? [{ storageAddress: published.anchorAddress, programName: published.programName }] : [] });
    }
    return published && String(url).endsWith(published.anchorAddress)
      ? Response.json({ success: true, data: published.listing, owner: `0x${keyHex}`, programName: published.programName })
      : new Response(null, { status: 404 });
  };
  try {
    const identity = await (await POST(request(input))).json() as { identityMessage: string; identityPresentedAt: number; listingVersion: number };
    assert.equal(identity.listingVersion, 1, "the first response names the version to carry through the retries");
    const authenticated = { ...input, listingVersion: identity.listingVersion,
      identityPresentedAt: identity.identityPresentedAt, identitySignature: walletSignature(identity.identityMessage) };
    const preview = await (await POST(request(authenticated))).json() as { message: string };
    const signed = { ...authenticated, listingSignature: walletSignature(preview.message) };
    const built = await (await POST(request(signed))).json() as NonNullable<typeof published> & { tx: unknown };
    assert.ok(built.tx, "the first signed request prepares the write");
    published = built;
    store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [{ primaryClaim: claim, displayName: base.name, listings: [{
      listingId: input.serviceId, version: 1, anchor: { kind: "storage-program", locator: built.anchorAddress } }] }] } as never);

    const retried = await (await POST(request(signed))).json() as { exists: boolean; tx: unknown; anchorAddress: string };
    assert.equal(retried.exists, true, "the indexed version is resolved, not renumbered");
    assert.equal(retried.tx, null);
    assert.equal(retried.anchorAddress, built.anchorAddress);
    for (const listingVersion of [0, 3, 1.5, "1", null, undefined]) {
      const refused = await POST(request({ ...signed, listingVersion }));
      assert.equal(refused.status, 400, `listingVersion ${JSON.stringify(listingVersion)}`);
      assert.match((await refused.json() as { error: string }).error, /listingVersion must be/);
    }
  } finally {
    globalThis.fetch = originalFetch;
    store.saveCatalog({ catalogVersion: "1", generatedAt: 2, sellers: [] });
  }
});

test("a signed retry for a version the catalog lists but the chain lookup cannot find prepares no second create", async () => {
  const store = await import("../src/catalog/store.js");
  const input = { ...base, serviceId: "listed-but-not-found" };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const deployment = deploymentReply(init);
    if (deployment) return deployment;
    if (init?.method !== "POST") return new Response(null, { status: 404 });
    const message = JSON.parse(String(init.body)).params?.[0]?.message;
    return Response.json({ result: 200, response: message === "searchStoragePrograms" ? [] : 0 });
  };
  try {
    const identity = await (await POST(request(input))).json() as { identityMessage: string; identityPresentedAt: number; listingVersion: number };
    const authenticated = { ...input, listingVersion: identity.listingVersion,
      identityPresentedAt: identity.identityPresentedAt, identitySignature: walletSignature(identity.identityMessage) };
    const preview = await (await POST(request(authenticated))).json() as { message: string };
    const signed = { ...authenticated, listingSignature: walletSignature(preview.message) };
    const prepared = await (await POST(request(signed))).json() as { tx: unknown; anchorAddress: string };
    assert.ok(prepared.tx, "with no catalog row the write is prepared");

    // The catalog now lists that version at an anchor this producer's names do not resolve.
    store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [{ primaryClaim: claim, displayName: base.name, listings: [{
      listingId: input.serviceId, version: identity.listingVersion, anchor: { kind: "storage-program", locator: "stor-other-anchor" } }] }] } as never);
    const retried = await POST(request(signed));
    assert.equal(retried.status, 409);
    const body = await retried.json() as { error: string; tx?: unknown; anchorAddress?: string };
    assert.match(body.error, /preparation.*unresolved/, "the retained preparation is reported, not a generic refusal");
    assert.equal(body.anchorAddress, prepared.anchorAddress);
    assert.equal(body.tx, undefined, "a version the catalog lists never gets its transaction again");
  } finally {
    globalThis.fetch = originalFetch;
    store.saveCatalog({ catalogVersion: "1", generatedAt: 2, sellers: [] });
  }
});

// The same table runs against the live route, so the builder and the route cannot drift apart.
const { POST: routePost } = await import("../app/api/dacs/build-listing/route.js");
const publishers = { builder: POST, route: routePost };

for (const category of [".services.other", "services.other.", "services..other", ".", ".."]) {
  test(`publisher rejects empty category segments in ${JSON.stringify(category)} before requesting a signature`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls += 1;
      throw new Error("category rejection must precede network access");
    });
    for (const [publisher, post] of Object.entries(publishers)) {
      const response = await post(request({ ...base, category }));
      assert.equal(response.status, 400, publisher);
      const body = await response.json();
      assert.match(body.error, /category must be dot-notation/, publisher);
      assert.equal(body.identityMessage, undefined, publisher);
      assert.equal(body.tx, undefined, publisher);
    }
    assert.equal(calls, 0);
  });
}

test("publisher accepts nonempty category segments after normalization", async () => {
  for (const category of ["services", " services.CODE-review "]) {
    const response = await POST(request({ ...base, category }));
    assert.equal(response.status, 200);
    assert.ok((await response.json()).identityMessage);
  }
});

test("every request after the first must carry the version the first returned, checked before any network read", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    throw new Error("a version refusal must precede network access");
  });
  const input = { ...base, serviceId: "version-input" };
  const identity = await (await POST(request(input))).json() as { identityMessage: string; identityPresentedAt: number; listingVersion: number };
  assert.equal(identity.listingVersion, 1);
  const authenticated = { ...input, identityPresentedAt: identity.identityPresentedAt, identitySignature: walletSignature(identity.identityMessage) };
  for (const [stage, body] of Object.entries({ preview: authenticated, signed: { ...authenticated, listingSignature: "ab".repeat(64) } })) {
    for (const listingVersion of [undefined, 0, -1, 1.5, "1", null, 2]) {
      const response = await POST(request({ ...body, listingVersion }));
      assert.equal(response.status, 400, `${stage} ${JSON.stringify(listingVersion)}`);
      assert.match((await response.json() as { error: string }).error, /listingVersion must be/);
    }
  }
  assert.equal(calls, 0);
});

test("a Service ID whose versions are exhausted is refused with no network read", async (t) => {
  const store = await import("../src/catalog/store.js");
  store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [{ primaryClaim: claim, displayName: base.name, listings: [{
    listingId: "exhausted", version: Number.MAX_SAFE_INTEGER, anchor: { kind: "storage-program", locator: `stor-${"e".repeat(40)}` } }] }] } as never);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    throw new Error("an exhausted version refusal must precede network access");
  });
  try {
    const response = await POST(request({ ...base, serviceId: "exhausted" }));
    assert.equal(response.status, 400);
    assert.match((await response.json() as { error: string }).error, /no next listing version/);
    assert.equal(calls, 0);
  } finally {
    store.saveCatalog({ catalogVersion: "1", generatedAt: 2, sellers: [] });
  }
});

test("an occupied valid version is recovered before, and without, checking a retry's Listing signature", async (t) => {
  const store = await import("../src/catalog/store.js");
  const input = { ...base, serviceId: "recover-first" };
  let published: { anchorAddress: string; programName: string; listing: Record<string, unknown> } | undefined;
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const deployment = deploymentReply(init);
    if (deployment) return deployment;
    if (init?.method === "POST") {
      const message = JSON.parse(String(init.body)).params?.[0]?.message;
      assert.notEqual(published && message, "getAddressNonce", "recovery never reads a write nonce");
      return Response.json({ result: 200, response: message !== "searchStoragePrograms" ? 0
        : published ? [{ storageAddress: published.anchorAddress, programName: published.programName }] : [] });
    }
    return published && String(url).endsWith(published.anchorAddress)
      ? Response.json({ success: true, data: published.listing, owner: `0x${keyHex}`, programName: published.programName })
      : new Response(null, { status: 404 });
  });
  const identity = await (await POST(request(input))).json() as { identityMessage: string; identityPresentedAt: number; listingVersion: number };
  const authenticated = { ...input, listingVersion: identity.listingVersion,
    identityPresentedAt: identity.identityPresentedAt, identitySignature: walletSignature(identity.identityMessage) };
  const preview = await (await POST(request(authenticated))).json() as { message: string };
  const signed = { ...authenticated, listingSignature: walletSignature(preview.message) };
  const built = await (await POST(request(signed))).json() as NonNullable<typeof published> & { tx: unknown; contentHash: string };
  assert.ok(built.tx);
  published = built;
  type Recovered = { exists: boolean; tx: unknown; anchorAddress: string; contentHash: string; listing: unknown; registration: { displayName: string } };
  const recoveredBy = async (body: Record<string, unknown>, label: string) => {
    const response = await POST(request(body));
    assert.equal(response.status, 200, label);
    const recovered = await response.json() as Recovered;
    assert.equal(recovered.exists, true, label);
    assert.equal(recovered.tx, null, label);
    assert.equal(recovered.anchorAddress, built.anchorAddress, label);
    assert.equal(recovered.contentHash, built.contentHash, label);
    assert.deepEqual(recovered.listing, built.listing, label);
    return recovered;
  };
  try {
    for (const [label, listingSignature] of Object.entries({
      "a garbled signature": "ab".repeat(64),
      "a stale signature over other bytes": walletSignature(`${preview.message}0`),
      "a value that is not a signature": "zz",
    })) await recoveredBy({ ...authenticated, listingSignature }, label);
    // The catalog's display name changes after the preview, so the rebuilt bytes differ from the stored ones.
    store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [{ primaryClaim: claim, displayName: "Renamed seller", listings: [{
      listingId: input.serviceId, version: 1, anchor: { kind: "storage-program", locator: built.anchorAddress } }] }] } as never);
    const renamed = await recoveredBy(signed, "after a display-name change");
    assert.equal(renamed.registration.displayName, base.name, "the registration keeps the stored artifact's name");
  } finally {
    store.saveCatalog({ catalogVersion: "1", generatedAt: 2, sellers: [] });
  }
});
