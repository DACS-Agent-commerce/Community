import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { deriveStorageAddress, LIVE_STORAGE_SALT } from "../src/catalog/chain.js";
import { verifyListing } from "../src/catalog/listingVerification.js";

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

test("publisher builds a verifiable metered listing with the AP2 rail/phase binding", async () => {
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
    const built = await response.json() as {
      listing: Record<string, unknown>;
      message: string;
      contentHash: string;
      logicalAddress: string;
      programName: string;
      anchorAddress: string;
      exists: boolean;
      tx: { content: { nonce: number; data: [string, Record<string, unknown>] } };
    };
    assert.deepEqual(built.listing.pricing, {
      kind: "metered",
      unitPrice: { amount: "0.02", currency: "USD" },
      unit: "API call",
      minTotal: { amount: "1", currency: "USD" },
    });
    assert.deepEqual(built.listing.acceptedRails, [{ railId: "ap2:stripe-paymentintents" }]);
    assert.deepEqual(built.listing.pipeline, [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-agreement" },
      { kind: "pay-ap2", parameters: { rail: "ap2:stripe-paymentintents" } },
      { kind: "deliver-storage-program" },
    ]);
    assert.equal(built.exists, false);
    assert.equal(built.logicalAddress, `dacs1:did%3Ademos%3Aagent%3A${keyHex}:metered-ap2:v1`);
    assert.ok(!built.programName.includes(":"), "the producer-held Demos name must be colon-free");
    assert.equal(built.tx.content.nonce, 1);
    assert.equal(built.tx.content.data[1].salt, "", "SDK #70 uses the live empty-salt convention");
    assert.equal(
      built.anchorAddress,
      deriveStorageAddress(`0x${keyHex}`, built.programName, 1, LIVE_STORAGE_SALT),
    );
    assert.equal(built.contentHash.length, 64);

    const listingSignature = Buffer.from(
      ed25519Sign(Buffer.from(built.message, "utf8"), privateKey),
    ).toString("base64url");
    assert.ok(await verifyListing({
      ...built.listing,
      signature: { algorithm: "ed25519", signer: claim, value: listingSignature },
    }));
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
    return Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
  };
  try {
    const builtResponse = await POST(request(finalInput));
    assert.equal(builtResponse.status, 200);
    const built = await builtResponse.json() as {
      listing: Record<string, unknown>;
      message: string;
      contentHash: string;
      programName: string;
      anchorAddress: string;
    };
    const listingSignature = Buffer.from(
      ed25519Sign(Buffer.from(built.message, "utf8"), privateKey),
    ).toString("base64url");
    const signedListing = {
      ...built.listing,
      signature: { algorithm: "ed25519", signer: claim, value: listingSignature },
    };

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

    const previousImports = process.env.DACS_HISTORICAL_LISTING_IMPORTS;
    signedListing.signature.value = Buffer.from(listingSignature, "base64url").toString("hex");
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
    } finally {
      if (previousImports === undefined) delete process.env.DACS_HISTORICAL_LISTING_IMPORTS;
      else process.env.DACS_HISTORICAL_LISTING_IMPORTS = previousImports;
    }
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

test("browser publisher refuses attested payloads before asking for a wallet signature", async () => {
  const response = await POST(request({ ...base, delivery: ["deliver-attested-payload"] }));
  assert.equal(response.status, 409);
  const body = await response.json() as { error: string; identityMessage?: string };
  assert.match(body.error, /cannot prove.*production capability/i);
  assert.equal(body.identityMessage, undefined);
});
