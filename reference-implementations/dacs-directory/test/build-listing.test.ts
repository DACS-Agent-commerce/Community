import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

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

const dataDir = mkdtempSync(join(tmpdir(), "dacs-build-listing-"));
process.env.DACS_DIRECTORY_DATA = join(dataDir, "directory.sqlite");
const { POST } = await import("../app/api/dacs/build-listing/route.js");

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

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

test("publisher uses PA-1 rail resolution and signs the exact staged Listing before creating a transaction", async () => {
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
      publicationReady: boolean;
      railResolution: { disposition: string; authorityBasis: string };
      payloadCapability: { disposition: string };
      tx: null;
    };
    assert.equal(preview.publicationReady, false);
    assert.equal(preview.tx, null, "an unsigned preview must not contain a broadcastable transaction");
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

test("publisher steps past an owner-held version whose artifact no longer authenticates", async () => {
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

    const preview = await (await POST(request(finalInput))).json() as Built;
    assert.equal(preview.exists, false);
    assert.equal(preview.listing.listingVersion, 2);
    assert.match(preview.logicalAddress, /:metered-ap2:v2$/);
    const builtResponse = await POST(request({ ...finalInput, listingSignature: walletHex(preview.message) }));
    assert.equal(builtResponse.status, 200);
    const built = await builtResponse.json() as Built;
    assert.equal(built.listing.listingVersion, 2);
    assert.notEqual(built.programName, occupied.name);
    assert.ok(built.tx, "the republished version is a new write");
    assert.ok(await verifyListing(built.listing));
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
    if (init?.method === "POST") {
      const rpc = JSON.parse(String(init.body)) as { params?: Array<{ message?: string }> };
      return rpc.params?.[0]?.message === "searchStoragePrograms"
        ? Response.json({ result: 200, response: [] })
        : Response.json({ result: 200, response: 6 });
    }
    return new Response(null, { status: 404 });
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

    const recoveredResponse = await POST(request(finalInput));
    assert.equal(recoveredResponse.status, 200);
    const recovered = await recoveredResponse.json() as {
      exists: boolean;
      tx: unknown;
      message?: string;
      listing: Record<string, unknown>;
      contentHash: string;
      anchorAddress: string;
    };
    assert.equal(recovered.exists, true);
    assert.equal(recovered.tx, null);
    assert.equal(recovered.message, undefined);
    assert.equal(recovered.anchorAddress, built.anchorAddress);
    assert.equal(recovered.contentHash, built.contentHash);
    assert.deepEqual(recovered.listing, signedListing);
  } finally {
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
