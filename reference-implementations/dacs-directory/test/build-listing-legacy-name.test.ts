import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { PINNED_DEMOS_CHAIN_IDENTITY, PINNED_DEMOS_NODE_BUILDS } from "../src/catalog/nodeDeployment.js";
import { signedRailSnapshot } from "./signed-rail-snapshot.js";

const dataDir = mkdtempSync(join(tmpdir(), "dacs-build-listing-legacy-"));
process.env.DACS_DIRECTORY_DATA = join(dataDir, "directory.sqlite");
const { createBuildListingPost } = await import("../src/catalog/buildListing.js");
const POST = createBuildListingPost(signedRailSnapshot);

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const cleanBuild = { commit: PINNED_DEMOS_NODE_BUILDS[0], dirty: false, builtAt: "2026-10-14T16:45:24Z" };

/** Answer the deployment preflight as the pinned build and chain; null for other calls. */
function deploymentReply(init: RequestInit | undefined): Response | null {
  if (init?.method !== "POST") return null;
  const call = (JSON.parse(String(init.body)) as { params?: Array<{ message?: string; data?: { blockNumber?: number } }> }).params?.[0];
  if (call?.message === "getNetworkInfo") return Response.json({ result: 200, response: { nodeVersion: cleanBuild } });
  if (call?.message === "getBlockByNumber" && call.data?.blockNumber === 0) return Response.json({ result: 400, response: "error" });
  if (call?.message === "getBlockByNumber" && call.data?.blockNumber === 1) {
    return Response.json({
      result: 200,
      response: { id: 2, number: 1, status: "confirmed", hash: "12".repeat(32), content: { previousHash: PINNED_DEMOS_CHAIN_IDENTITY, timestamp: 1 } },
    });
  }
  return null;
}

const seed = Uint8Array.from(Buffer.alloc(32, 14));
const privateKey = privateKeyFromSeed(seed);
const keyHex = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex");
const claim = `did:demos:agent:${keyHex}`;
const base = {
  claim,
  serviceId: "legacy-name",
  name: "Legacy name service",
  description: "A service whose first version may sit under main's program name.",
  rails: ["ap2:stripe-paymentintents"],
  delivery: ["deliver-storage-program"],
  pricing: { kind: "metered", amount: "0.02", currency: "USD", unit: "API call", minTotal: "1" },
};
const request = (body: Record<string, unknown>) => new NextRequest("https://directory.example/api/dacs/build-listing", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const walletHex = (message: string) => Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKey)).toString("hex");

// Earlier /register versions named the StorageProgram `dacs1-<base64url(logical address)>`.
// DACS-1 §6.3.4 versioning (listingVersion monotonic per listingId, versions MUST NOT be
// skipped) and LP-3 apply to those anchors too, so the occupancy check reads both names.
const legacyProgramName = (version: number) =>
  `dacs1-${Buffer.from(`dacs1:${encodeURIComponent(claim)}:${base.serviceId}:v${version}`, "utf8").toString("base64url")}`;

type V1 = { programName: string; anchorAddress: string; listing: Record<string, unknown> };
type Built = { exists: boolean; tx: { content: { data: [string, { programName: string }] } } | null; programName: string; error?: string; listing?: unknown };

async function withOccupancy(
  occupy: (v1: V1) => { name: string; data: Record<string, unknown> },
  check: (ctx: { post: () => Promise<Response>; queries: string[] }) => Promise<void>,
) {
  const identity = await (await POST(request(base))).json() as { identityMessage: string; identityPresentedAt: number };
  const finalInput = { ...base, identityPresentedAt: identity.identityPresentedAt, identitySignature: walletHex(identity.identityMessage) };
  let occupied: { name: string; data: Record<string, unknown>; address: string } | null = null;
  const queries: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const deployment = deploymentReply(init);
    if (deployment) return deployment;
    if (init?.method === "POST") {
      const rpc = JSON.parse(String(init.body)) as { params?: Array<{ message?: string; data?: { query?: string } }> };
      if (rpc.params?.[0]?.message === "searchStoragePrograms") {
        queries.push(String(rpc.params[0].data?.query));
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
  try {
    const preview = await (await POST(request(finalInput))).json() as { message: string };
    const post = () => POST(request({ ...finalInput, listingSignature: walletHex(preview.message) }));
    const v1 = await (await post()).json() as V1;
    occupied = { ...occupy(v1), address: v1.anchorAddress };
    queries.length = 0;
    await check({ post, queries });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("a version main's /register anchored under its program name is occupied and is not published again", async () => {
  await withOccupancy(
    (v1) => {
      const signature = v1.listing.signature as Record<string, unknown> & { value: string };
      // main wrote the wallet's hex into the Listing signature, which no current reader accepts.
      const data = { ...v1.listing, signature: { ...signature, value: Buffer.from(signature.value, "base64url").toString("hex") } };
      return { name: legacyProgramName(1), data };
    },
    async ({ post, queries }) => {
      for (let i = 0; i < 2; i++) {
        const response = await post();
        assert.equal(response.status, 409, "the occupied legacy v1 is not published a second time");
        const body = await response.json() as Built;
        assert.match(String(body.error), /choose a new Service ID/);
        assert.equal(body.tx, undefined);
        assert.equal(body.listing, undefined, "no second v1 artifact is issued for signing");
      }
      assert.ok(queries.includes(legacyProgramName(1)), "the legacy name is looked up");
    },
  );
});

test("an authenticated listing under the legacy program name is recovered without a second write", async () => {
  await withOccupancy(
    (v1) => ({ name: legacyProgramName(1), data: v1.listing }),
    async ({ post }) => {
      const response = await post();
      assert.equal(response.status, 200);
      const body = await response.json() as Built;
      assert.equal(body.exists, true);
      assert.equal(body.tx, null, "the recovered version is not written again");
      assert.equal(body.programName, legacyProgramName(1), "the report names the program that is on chain");
    },
  );
});

test("a legacy program name for another version leaves this version free to publish", async () => {
  await withOccupancy(
    (v1) => ({ name: legacyProgramName(2), data: v1.listing }),
    async ({ post, queries }) => {
      const response = await post();
      assert.equal(response.status, 200);
      const body = await response.json() as Built;
      assert.equal(body.exists, false);
      assert.ok(body.tx, "an unoccupied version is still published");
      assert.equal(body.tx.content.data[1].programName, body.programName);
      assert.notEqual(body.programName, legacyProgramName(1), "new programs are not created under the legacy name");
      assert.ok(queries.includes(legacyProgramName(1)), "the legacy name is looked up");
    },
  );
});

test("an unreadable legacy-name lookup withholds the create transaction", async () => {
  const identity = await (await POST(request(base))).json() as { identityMessage: string; identityPresentedAt: number };
  const finalInput = { ...base, identityPresentedAt: identity.identityPresentedAt, identitySignature: walletHex(identity.identityMessage) };
  let legacyDown = false;
  const nonceReads: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const deployment = deploymentReply(init);
    if (deployment) return deployment;
    if (init?.method !== "POST") return new Response(null, { status: 404 });
    const call = (JSON.parse(String(init.body)) as { params?: Array<{ message?: string; data?: { query?: string } }> }).params?.[0];
    if (call?.message === "getAddressNonce") nonceReads.push(call.message);
    if (call?.message === "searchStoragePrograms" && legacyDown && call.data?.query === legacyProgramName(1)) {
      return new Response("unavailable", { status: 503 });
    }
    return Response.json({ result: 200, response: call?.message === "searchStoragePrograms" ? [] : 0 });
  };
  try {
    const preview = await (await POST(request(finalInput))).json() as { message: string };
    legacyDown = true;
    const response = await POST(request({ ...finalInput, listingSignature: walletHex(preview.message) }));
    assert.equal(response.status, 503);
    const body = await response.json() as Built;
    assert.match(String(body.error), /could not safely determine whether this listing version already exists/);
    assert.equal(body.tx, undefined, "a legacy name that cannot be read may still hold this version");
    assert.deepEqual(nonceReads, [], "no write nonce is requested");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
