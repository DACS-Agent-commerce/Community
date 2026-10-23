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
  const authenticated = { ...input, identityPresentedAt: identity.identityPresentedAt,
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
    assert.equal(listingCalls, 1, "the Listing verifier exception path was reached");
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
  const identity = await (await POST(request(base))).json() as { identityMessage: string; identityPresentedAt: number };
  const walletHex = (message: string) =>
    Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKey)).toString("hex");
  const finalInput = {
    ...base,
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
  const identity = await identityResponse.json() as { identityMessage: string; identityPresentedAt: number };
  const identitySignature = Buffer.from(
    ed25519Sign(Buffer.from(identity.identityMessage, "utf8"), privateKey),
  ).toString("hex");
  const finalInput = { ...base, identityPresentedAt: identity.identityPresentedAt, identitySignature };

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
  const identity = await (await POST(request(base))).json() as { identityMessage: string; identityPresentedAt: number };
  const hexSig = (message: string) =>
    Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKey)).toString("hex");
  const finalInput = {
    ...base,
    serviceId: "deployment-pin",
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
      ["unreadable node", { nodeVersion: cleanBuild, chain: PINNED_DEMOS_CHAIN_IDENTITY, down: true }, 503, /could not read the Demos node/],
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

test("browser publisher refuses attested payloads without seller-runtime production capability", async () => {
  const identityResponse = await POST(request({ ...base, delivery: ["deliver-attested-payload"] }));
  const identity = await identityResponse.json() as { identityMessage: string; identityPresentedAt: number };
  const identitySignature = Buffer.from(
    ed25519Sign(Buffer.from(identity.identityMessage, "utf8"), privateKey),
  ).toString("hex");
  const response = await POST(request({
    ...base,
    delivery: ["deliver-attested-payload"],
    identityPresentedAt: identity.identityPresentedAt,
    identitySignature,
  }));
  assert.equal(response.status, 409);
  assert.match(String((await response.json()).error), /cannot prove.*production capability/i);
});

test("publisher refuses a new write when existing-publication lookup is indeterminate", async () => {
  const identityResponse = await POST(request(base));
  const identity = await identityResponse.json() as { identityMessage: string; identityPresentedAt: number };
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
  const identity = await (await POST(request(base))).json() as { identityMessage: string; identityPresentedAt: number };
  const otherKey = privateKeyFromSeed(Uint8Array.from(Buffer.alloc(32, 13)));
  const hexSig = (message: string, key = privateKey) =>
    Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), key)).toString("hex");
  const finalInput = {
    ...base,
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
  const identity = await identityResponse.json() as { identityMessage: string; identityPresentedAt: number };
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
    const response = await POST(request({ ...base, identityPresentedAt: identity.identityPresentedAt, identitySignature }));
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.match(body.error, /could not safely determine.*cannot establish absence/);
    assert.equal(body.tx, undefined);
    assert.deepEqual(methods, ["nodeCall", "gcr_routine"], "no fresh nonce may be requested after an incomplete lookup");
  } finally {
    globalThis.fetch = originalFetch;
  }
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
  const identity = await (await POST(request(base))).json() as { identityMessage: string; identityPresentedAt: number };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => init?.method === "POST"
    ? Response.json({ result: 200, response: JSON.parse(String(init.body)).params?.[0]?.message === "searchStoragePrograms" ? [] : 0 })
    : new Response(null, { status: 404 });
  try {
    const preview = async (serviceId: string) => (await (await POST(request({
      ...base,
      serviceId,
      identityPresentedAt: identity.identityPresentedAt,
      identitySignature: Buffer.from(ed25519Sign(Buffer.from(identity.identityMessage, "utf8"), privateKey)).toString("hex"),
    }))).json() as { listing: { listingVersion: number } }).listing.listingVersion;
    assert.equal(await preview(base.serviceId), 3, "the next version of this listingId");
    assert.equal(await preview("fresh-listing"), 1, "another listingId's versions are not inherited");
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
      const body = { ...base, rails: [railId], pricing: { kind: "fixed", amount: "1", currency } };
      const stage = await POST(request(body));
      assert.equal(stage.status, 200);
      const identity = await stage.json() as { identityMessage: string; identityPresentedAt: number };
      const response = await POST(request({ ...body, identityPresentedAt: identity.identityPresentedAt,
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

/** Answer only the explicitly modelled read RPCs, never contact a node. */
function emptyPublisherChain(nonceReply: () => Response = () => Response.json({ result: 200, response: 0 })): typeof fetch {
  return async (_input, init) => {
    const deployment = deploymentReply(init);
    if (deployment) return deployment;
    const call = JSON.parse(String(init?.body)).params[0];
    if (call.message === "searchStoragePrograms") return Response.json({ result: 200, response: [] });
    assert.equal(call.message, "getAddressNonce");
    return nonceReply();
  };
}

async function publisherIdentity(body: Record<string, unknown> = base, key = privateKey) {
  const response = await POST(request(body));
  assert.equal(response.status, 200, await response.clone().text());
  const identity = await response.json();
  return { ...body, identityPresentedAt: identity.identityPresentedAt, identitySignature: walletSignature(identity.identityMessage, key) };
}

test("publisher validates optional and required input before offering a signing preimage", async () => {
  const invalid: unknown[] = [null, {}, { ...base, claim: undefined }, { ...base, claim: null }, { ...base, claim: `${claim}junk` }];
  for (const key of ["serviceId", "name", "description"]) {
    for (const value of [undefined, null, "", "   "]) invalid.push({ ...base, [key]: value });
  }
  for (const [key, values] of Object.entries({
    serviceId: ["UPPER", "with/slash", "x".repeat(65)], name: ["x".repeat(201)], description: ["x".repeat(2001)],
    rails: [null, "ap2:stripe-paymentintents", [], Array(17).fill(base.rails[0]), [base.rails[0], null], [base.rails[0], ""], [base.rails[0], base.rails[0]], ["unknown:rail"]],
    delivery: [null, "deliver-storage-program", [], Array(17).fill("deliver-storage-program"), ["deliver-storage-program", null], ["deliver-storage-program", ""], ["deliver-storage-program", "deliver-entitlement"], ["deliver-unknown"]],
    category: ["", "with/slash", "x".repeat(65)],
    tags: [null, "tag", [7], Array(17).fill("tag"), ["x".repeat(33)]],
    publicEndpoint: ["http://example.com/", "javascript:alert(1)"],
  })) for (const value of values) invalid.push({ ...base, [key]: value });
  for (const body of invalid) {
    const response = await POST(request(body as Record<string, unknown>));
    assert.equal(response.status, 400, JSON.stringify(body));
    const result = await response.json();
    assert.equal(result.tx, undefined);
    assert.equal(result.identityMessage, undefined);
  }
  for (const extra of [{ serviceId: "x".repeat(64) }, { name: "x".repeat(200) }, { description: "x".repeat(2000) },
    { tags: Array(16).fill("x".repeat(32)) }, { category: "x".repeat(64) },
    { publicEndpoint: "https://127.0.0.1/" }]) {
    const response = await POST(request({ ...base, ...extra }));
    assert.equal(response.status, 200);
    assert.ok((await response.json()).identityMessage);
  }
});

test("publisher normalizes fields, emits entitlement terms and retains all supported delivery decisions", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = emptyPublisherChain();
  try {
    const input = await publisherIdentity({ ...base, serviceId: "  normalized  ", name: "  Name  ", description: "  Description  ",
      category: "  Services.Test  ", tags: ["  one  ", " ", "two"], publicEndpoint: "  https://example.com/api  ",
      delivery: ["deliver-entitlement"] });
    const response = await POST(request(input));
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.equal(preview.listing.listingId, "normalized");
    assert.equal(preview.listing.seller.displayName, "Name");
    assert.equal(preview.listing.seller.publicEndpoint, "https://example.com/api");
    assert.deepEqual(preview.listing.offering, { title: "Name", description: "Description", category: "services.test", tags: ["one", "two"],
      deliverable: { kind: "entitlement", durationSec: 2_592_000, renewable: false } });
    assert.equal(preview.listing.pipeline[3].kind, "deliver-entitlement");
    const attested = await POST(request(await publisherIdentity({ ...base, delivery: ["deliver-attested-payload"] })));
    assert.equal(attested.status, 409);
    assert.match((await attested.json()).error, /attested-payload production capability/);
  } finally { globalThis.fetch = originalFetch; }
});

test("publisher pricing validates each model and emits normalized terms and negotiation parameters", async () => {
  const invalid = [
    { kind: "barter" }, ...["", "0", "-1", "01", "1.0", "1e2", "Infinity"].map(amount => ({ amount })),
    ...["", "USD/DEM", "x".repeat(33)].map(currency => ({ currency })),
    ...[{ minPct: -1, maxPct: 1 }, { minPct: 100, maxPct: 1 }, { minPct: 1, maxPct: -1 }, { maxPct: 1 }, { minPct: 1 }]
      .map(fields => ({ kind: "negotiable", ...fields })),
    { kind: "auction", selectionRule: "unknown" },
    ...["", " ", "x".repeat(65)].map(unit => ({ kind: "metered", unit })),
    ...["0", "01", "-1", "1.0"].map(minTotal => ({ kind: "metered", unit: "call", minTotal })),
  ];
  for (const pricing of invalid) {
    const response = await POST(request({ ...base, pricing: { amount: "10", currency: "USD", ...pricing } }));
    assert.equal(response.status, 400, JSON.stringify(pricing));
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = emptyPublisherChain();
  try {
    const cases: Array<{ kind?: string; amount: string; currency: string; unit?: string; minTotal?: string;
      minPct?: number; maxPct?: number; selectionRule?: string }> = [
      { amount: " 1.25 ", currency: " USD ", unit: " call " },
      { kind: "fixed", amount: "1", currency: "USD" },
      { kind: "fixed", amount: "1", currency: "USD", unit: " " },
      { kind: "fixed", amount: "1", currency: "USD", unit: "x".repeat(65) },
      { kind: "negotiable", amount: "10", currency: "USD", minPct: 0, maxPct: 0 },
      { kind: "negotiable", amount: "10", currency: "USD", minPct: 99, maxPct: 1000 },
      ...[undefined, "lowest-price", "highest-price", "first-acceptable"].map(selectionRule => ({ kind: "auction", amount: "10", currency: "USD", selectionRule })),
      { kind: "metered", amount: "0.01", currency: "USD", unit: ` ${"x".repeat(64)} ` },
      { kind: "metered", amount: "0.01", currency: "USD", unit: " call ", minTotal: " 1.25 " },
    ];
    for (const pricing of cases) {
      const input = await publisherIdentity({ ...base, pricing });
      const response = await POST(request(input));
      assert.equal(response.status, 200, JSON.stringify(pricing));
      const { listing } = await response.json();
      const kind = pricing.kind ?? "fixed";
      const price = { amount: pricing.amount.trim(), currency: pricing.currency.trim(),
        ...(kind !== "metered" && pricing.unit?.trim() ? { unit: pricing.unit.trim().slice(0, 64) } : {}) };
      const expected = kind === "fixed" ? { kind, price }
        : kind === "negotiable" ? { kind, bandCenter: price, minPct: pricing.minPct, maxPct: pricing.maxPct }
        : kind === "auction" ? { kind, reservePrice: price, selectionRule: pricing.selectionRule ?? "first-acceptable" }
        : { kind, unitPrice: price, unit: pricing.unit!.trim(), ...(pricing.minTotal ? { minTotal: { amount: pricing.minTotal.trim(), currency: "USD" } } : {}) };
      assert.deepEqual(listing.pricing, expected);
      const deadline = input.identityPresentedAt + 7 * 24 * 60 * 60 * 1000;
      assert.deepEqual(listing.validity, { notBefore: input.identityPresentedAt, ...(kind === "auction" ? { notAfter: deadline } : {}) });
      assert.deepEqual(listing.pipeline[0], kind === "auction"
        ? { kind: "negotiate-sealed-envelope", parameters: { commitDeadline: deadline, revealWindow: 3600, selectionRule: pricing.selectionRule ?? "first-acceptable" } }
        : kind === "negotiable" ? { kind: "negotiate-rfq", parameters: { maxTurns: 8, timeoutSec: 300, rfqInitiator: "buyer" } }
        : { kind: "negotiate-fixed-price" });
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("publisher signature import accepts wallet prefixes and rejects trailing junk and wrong identity proofs", async () => {
  const input = await publisherIdentity();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = emptyPublisherChain();
  try {
    for (const prefix of ["", "0x", "0x0x"]) {
      const response = await POST(request({ ...input, identitySignature: prefix + input.identitySignature }));
      assert.equal(response.status, 200, prefix);
      const preview = await response.json();
      assert.equal(preview.artifactProfile, "dacs-v0.1");
      assert.equal(preview.exists, false);
      const signed = await POST(request({ ...input, identitySignature: prefix + input.identitySignature,
        listingSignature: prefix + walletSignature(preview.message) }));
      assert.equal(signed.status, 200, prefix);
      assert.ok((await signed.json()).tx);
    }
    const other = privateKeyFromSeed(Uint8Array.from(Buffer.alloc(32, 13)));
    const identityMessage = `dacs-bundle-presentation:v1:${contentHash({ bundleVersion: "1", presentedBy: claim,
      presentedAt: input.identityPresentedAt, claims: [{ ref: claim }] })}`;
    for (const identitySignature of [input.identitySignature + "junk", walletSignature("wrong message"), walletSignature(identityMessage, other), "ff".repeat(64)]) {
      const response = await POST(request({ ...input, identitySignature }));
      assert.equal(response.status, 400);
      const result = await response.json();
      assert.equal(result.tx, undefined);
      assert.equal(result.listing, undefined);
    }
    const malformedClaim = `did:demos:agent:${"ff".repeat(32)}`;
    const malformedScope = { bundleVersion: "1", presentedBy: malformedClaim, presentedAt: input.identityPresentedAt,
      claims: [{ ref: malformedClaim }] };
    const malformed = await POST(request({ ...input, claim: malformedClaim,
      identitySignature: walletSignature(`dacs-bundle-presentation:v1:${contentHash(malformedScope)}`) }));
    assert.equal(malformed.status, 400, "malformed-key verification errors must be controlled refusals");
    assert.equal((await malformed.json()).tx, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test("publisher identity freshness accepts the exact skew limits", async (t) => {
  const now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = emptyPublisherChain();
  try {
    for (const [offset, accepted] of [[-900_001, false], [-900_000, true], [60_000, true], [60_001, false], [0.5, false]] as const) {
      const presentedAt = now + offset;
      const message = Number.isSafeInteger(presentedAt) ? `dacs-bundle-presentation:v1:${contentHash({ bundleVersion: "1", presentedBy: claim, presentedAt, claims: [{ ref: claim }] })}` : "unrepresentable";
      const response = await POST(request({ ...base, identityPresentedAt: presentedAt, identitySignature: walletSignature(message) }));
      assert.equal(response.status, accepted ? 200 : 409, String(offset));
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("publisher nonce reads pin the transport and reject unusable node replies", async () => {
  const input = await publisherIdentity();
  const originalFetch = globalThis.fetch;
  let reply = () => Response.json({ result: 200, response: 0 });
  globalThis.fetch = async (url, init) => {
    const call = JSON.parse(String(init?.body)).params[0];
    if (call.message === "getAddressNonce") {
      assert.equal(String(url), `${(process.env.DEMOS_RPC ?? "https://demosnode.discus.sh/").replace(/\/$/, "")}/`);
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
      assert.deepEqual(JSON.parse(String(init?.body)), { method: "nodeCall", params: [{ type: "nodeCall", message: "getAddressNonce",
        sender: null, receiver: null, timestamp: null, data: { address: `0x${keyHex}` }, extra: "" }] });
      return reply();
    }
    return emptyPublisherChain()(url, init);
  };
  try {
    const preview = await (await POST(request(input))).json();
    const finalInput = { ...input, listingSignature: walletSignature(preview.message) };
    assert.equal((await POST(request(finalInput))).status, 200);
    for (const failure of [() => Response.json({ result: 200, response: 0 }, { status: 503 }),
      () => Response.json({ result: 400, response: 0 }), () => Response.json(null),
      ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "NaN", undefined].map(response => () => Response.json({ result: 200, response }))]) {
      reply = failure;
      await assert.rejects(POST(request(finalInput)), /nonce/);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("publisher enforces its ten-minute proxy rate window and request size cap", async (t) => {
  const { resetRateLimitState } = await import("../src/catalog/security.js");
  const previous = process.env.DACS_TRUST_PROXY;
  process.env.DACS_TRUST_PROXY = "1";
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  resetRateLimitState();
  const req = (ip: string, length?: number) => new NextRequest("https://directory.example/api/dacs/build-listing", {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(length ? { "content-length": String(length) } : {}) }, body: JSON.stringify(base) });
  try {
    for (let n = 0; n < 10; n++) assert.equal((await POST(req("203.0.113.1"))).status, 200);
    const limited = await POST(req("203.0.113.1"));
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "600");
    assert.equal((await POST(req("203.0.113.2"))).status, 200);
    now += 599_999;
    assert.equal((await POST(req("203.0.113.1"))).status, 429);
    now++;
    assert.equal((await POST(req("203.0.113.1"))).status, 200);
    assert.equal((await POST(req("203.0.113.3", 65_537))).status, 413);
    assert.equal((await POST(req("203.0.113.3", 65_536))).status, 200);
  } finally {
    resetRateLimitState();
    if (previous === undefined) delete process.env.DACS_TRUST_PROXY; else process.env.DACS_TRUST_PROXY = previous;
  }
});

test("publisher recovery refuses independently authenticated artifacts with a different tuple, seller or profile", async () => {
  const input = await publisherIdentity();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = emptyPublisherChain();
  try {
    const preview = await (await POST(request(input))).json();
    const scope = preview.listing;
    const otherSeed = Uint8Array.from(Buffer.alloc(32, 13));
    const otherKey = privateKeyFromSeed(otherSeed);
    const otherClaim = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(otherSeed))).toString("hex")}`;
    const identity = { bundleVersion: "1", presentedBy: otherClaim, presentedAt: input.identityPresentedAt, claims: [{ ref: otherClaim }] };
    const otherSeller = { ...scope.seller, identity: { ...identity, presentation: { kind: "per-claim", signatures: [
      { ref: otherClaim, signature: Buffer.from(walletSignature(`dacs-bundle-presentation:v1:${contentHash(identity)}`, otherKey), "hex").toString("base64url") },
    ] } } };
    const legacyScope = { agentId: claim, serviceId: base.serviceId, name: base.name, description: base.description,
      claimRequirements: [], supportedNegotiation: ["negotiate-fixed-price"], supportedPaymentRails: ["pay-dem"], supportedDelivery: ["deliver-storage-program"] };
    const candidates = [
      { body: { ...scope, listingId: "another-id" }, signer: claim, key: privateKey },
      { body: { ...scope, listingVersion: 2 }, signer: claim, key: privateKey },
      { body: { ...scope, seller: otherSeller }, signer: otherClaim, key: otherKey },
    ].map(({ body, signer, key }) => ({ ...body, signature: { algorithm: "ed25519", signer,
      value: Buffer.from(walletSignature(`dacs-listing:v1:${contentHash(body)}`, key), "hex").toString("base64url") } }));
    const occupied = [...candidates, { ...legacyScope, signature: walletSignature(`dacs-listing:v1:${contentHash(legacyScope)}`) }];
    const address = `stor-${"7".repeat(40)}`;
    for (const candidate of occupied) {
      assert.ok(await verifyListing(candidate), "the refusal must not be caused by an invalid signature or schema");
      globalThis.fetch = async (_url, init) => init?.method === "POST"
        ? Response.json({ result: 200, response: [{ storageAddress: address, programName: preview.programName }] })
        : Response.json({ success: true, owner: `0x${keyHex}`, programName: preview.programName, data: candidate });
      const response = await POST(request(input));
      assert.equal(response.status, 409);
      const result = await response.json();
      assert.equal(result.tx, undefined);
      assert.match(result.error, /expected authenticated listing candidate/);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("publisher chooses the matching catalog seller and preserves their registration data on recovery", async () => {
  const store = await import("../src/catalog/store.js");
  const priorCatalog = store.loadCatalog(), priorRegistrations = store.loadRegistrations();
  const other = `did:demos:agent:${"f".repeat(64)}`;
  const existingAnchor = `stor-${"1".repeat(40)}`, catalogAnchor = `stor-${"2".repeat(40)}`;
  const deal = { jobId: "prior-job", rail: "pay-dem", buyerBundleRef: `stor-${"3".repeat(40)}`, owners: { buyer: other, seller: claim } };
  const { logicalBundleAddress, verifyBundleBinding } = await import("../src/catalog/bundleBinding.js");
  const bindingScope = { bindingVersion: "1" as const, jobId: "prior-job", role: "seller" as const,
    logicalAddress: logicalBundleAddress("prior-job", "seller"), nativeAddress: `stor-${"4".repeat(40)}`,
    bundleContentHash: "b".repeat(64), signer: claim };
  const binding = { ...bindingScope, signature: { algorithm: "ed25519" as const, signer: claim,
    value: Buffer.from(walletSignature(`dacs-bundle-binding:v1:${contentHash(bindingScope)}`), "hex").toString("base64url") } };
  assert.ok(await verifyBundleBinding(binding));
  const summary = (primaryClaim: string, version: number) => ({ listingId: base.serviceId, version,
    anchor: { kind: "storage-program", locator: catalogAnchor }, seller: { primaryClaim } });
  store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [
    { primaryClaim: other, displayName: "Other seller", listings: [summary(other, 9)] },
    { primaryClaim: claim, displayName: "Original seller", listings: [summary(claim, 2)] },
  ] } as never);
  store.saveRegistrations([
    { primaryClaim: other, displayName: "Other seller", listingAnchors: [] },
    { primaryClaim: claim, displayName: "Prior name", listingAnchors: [existingAnchor], deals: [deal], bundleBindings: [binding] },
  ] as never);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = emptyPublisherChain();
  try {
    const input = await publisherIdentity();
    const preview = await (await POST(request(input))).json();
    assert.equal(preview.listing.listingVersion, 3);
    assert.equal(preview.listing.seller.displayName, "Original seller");
    const built = await (await POST(request({ ...input, listingSignature: walletSignature(preview.message) }))).json();
    globalThis.fetch = async (_url, init) => init?.method === "POST"
      ? Response.json({ result: 200, response: [{ storageAddress: built.anchorAddress, programName: built.programName }] })
      : Response.json({ success: true, owner: `0x${keyHex}`, programName: built.programName, data: built.listing });
    const response = await POST(request({ ...input, name: "Replacement request name" }));
    assert.equal(response.status, 200);
    const recovered = await response.json();
    assert.deepEqual(Object.keys(recovered).sort(), ["listing", "contentHash", "artifactProfile", "logicalAddress", "programName", "anchorAddress", "exists", "tx", "publicationReady", "railResolution", "payloadCapability", "registration"].sort());
    assert.equal(recovered.exists, true);
    assert.equal(recovered.tx, null);
    assert.equal(recovered.publicationReady, true);
    assert.equal(recovered.artifactProfile, "dacs-v0.1");
    const { ownerSignature, ...registration } = recovered.registration;
    assert.deepEqual(registration, { primaryClaim: claim, displayName: "Original seller",
      listingAnchors: [existingAnchor, catalogAnchor, built.anchorAddress], deals: [deal], bundleBindings: [binding] });
    const { registrationMessage } = await import("../src/catalog/registrationSig.js");
    assert.equal(ownerSignature.message, registrationMessage(registration, ownerSignature.signedAt));
    assert.equal(recovered.programName, built.programName);
    assert.equal(recovered.anchorAddress, built.anchorAddress);
    assert.equal(recovered.contentHash, built.contentHash);
    assert.deepEqual(recovered.listing, built.listing);
  } finally {
    globalThis.fetch = originalFetch;
    store.saveCatalog(priorCatalog);
    store.saveRegistrations(priorRegistrations);
  }
});
