import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { contentHash } from "@kynesyslabs/dacs/canonical";

import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { PINNED_DEMOS_CHAIN_IDENTITY, PINNED_DEMOS_NODE_BUILDS } from "../src/catalog/nodeDeployment.js";
import { signedRailSnapshot } from "./signed-rail-snapshot.js";
import { emptyListingOccupancy } from "./fixtures/listing-occupancy.js";

const dataDir = mkdtempSync(join(tmpdir(), "dacs-build-listing-legacy-"));
process.env.DACS_DIRECTORY_DATA = join(dataDir, "directory.sqlite");
const { createBuildListingPost } = await import("../src/catalog/buildListing.js");
const POST = createBuildListingPost(signedRailSnapshot, emptyListingOccupancy);

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
const legacyProgramName = (serviceId: string, version: number) =>
  `dacs1-${Buffer.from(`dacs1:${encodeURIComponent(claim)}:${serviceId}:v${version}`, "utf8").toString("base64url")}`;

type V1 = { programName: string; anchorAddress: string; logicalAddress: string; listing: Record<string, unknown>; tx: unknown };
type Built = { exists: boolean; tx: { content: { data: [string, { programName: string }] } } | null; programName: string; error?: string; listing?: unknown };

async function withOccupancy(
  serviceId: string,
  occupy: (v1: V1) => { name: string; data: Record<string, unknown> },
  check: (ctx: { post: () => Promise<Response>; postWithResolution: () => Promise<Response>; queries: string[]; v1: V1 }) => Promise<void>,
  prepareBeforeOccupancy = true,
) {
  const identity = await (await POST(request({ ...base, serviceId }))).json() as { identityMessage: string; identityPresentedAt: number; listingVersion: number };
  const finalInput = { ...base, serviceId, listingVersion: identity.listingVersion,
    identityPresentedAt: identity.identityPresentedAt, identitySignature: walletHex(identity.identityMessage) };
  let occupied: { name: string; data: Record<string, unknown>; address: string } | null = null;
  let logicalAddress: string | undefined;
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
      ? Response.json({ success: true, data: occupied.data, owner: `0x${keyHex}`, programName: occupied.name, metadata: { logicalAddress } })
      : new Response(null, { status: 404 });
  };
  try {
    const preview = await (await POST(request(finalInput))).json() as { message: string; programName: string; logicalAddress: string; listing: Record<string, unknown> };
    const post = () => POST(request({ ...finalInput, listingSignature: walletHex(preview.message) }));
    const v1: V1 = prepareBeforeOccupancy ? await (await post()).json() as V1
      : { programName: preview.programName, listing: preview.listing, logicalAddress: preview.logicalAddress,
        anchorAddress: `stor-${"e".repeat(40)}`, tx: null };
    logicalAddress = v1.logicalAddress;
    occupied = { ...occupy(v1), address: v1.anchorAddress };
    queries.length = 0;
    const postWithResolution = () => createBuildListingPost(signedRailSnapshot, async (logicalAddress, chainIdentity) => ({
      status: "complete", logicalAddress, chainIdentity, nativeAddresses: occupied ? [occupied.address] : [],
    }))(request({ ...finalInput, listingSignature: walletHex(preview.message) }));
    await check({ post, postWithResolution, queries, v1 });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("a version main's /register anchored under its program name is occupied and is not published again", async () => {
  await withOccupancy(
    "legacy-invalid",
    (v1) => {
      const signature = v1.listing.signature as Record<string, unknown> & { value: string };
      // main wrote the wallet's hex into the Listing signature, which no current reader accepts.
      const data = { ...v1.listing, signature: { ...signature, value: Buffer.from(signature.value, "base64url").toString("hex") } };
      return { name: legacyProgramName("legacy-invalid", 1), data };
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
      assert.ok(queries.includes(legacyProgramName("legacy-invalid", 1)), "the legacy name is looked up");
    },
  );
});

test("logical resolution recovers another producer's exact SDK-valid signed bytes without another write", async (t) => {
  t.mock.method(Date, "now", () => 1_800_000_000_000);
  let expected: Record<string, unknown> | undefined;
  await withOccupancy("independent-sdk-producer", (v1) => {
    expected = v1.listing;
    return { name: "another-producer-release-one", data: v1.listing };
  }, async ({ postWithResolution, queries }) => {
    const response = await postWithResolution();
    assert.equal(response.status, 200);
    const body = await response.json() as Built;
    assert.equal(body.exists, true);
    assert.equal(body.tx, null);
    assert.equal(body.programName, "another-producer-release-one");
    assert.deepEqual(body.listing, expected);
    assert.equal(queries.includes("another-producer-release-one"), false, "name indexes do not discover this publication");
  });
});

for (const mismatch of ["signature", "version"] as const) {
  test(`a logically resolved occupied Listing with a mismatched ${mismatch} blocks creation`, async (t) => {
    t.mock.method(Date, "now", () => 1_800_000_000_000);
    await withOccupancy(`independent-invalid-${mismatch}`, (v1) => {
      const { signature: priorSignature, ...scope } = v1.listing;
      const changed = { ...scope, listingVersion: 2 };
      const signature = mismatch === "signature" ? priorSignature : {
        algorithm: "ed25519", signer: claim,
        value: Buffer.from(walletHex(`dacs-listing:v1:${contentHash(changed)}`), "hex").toString("base64url"),
      };
      return { name: "other-producer-occupied", data: { ...changed, signature } };
    }, async ({ postWithResolution }) => {
      const response = await postWithResolution();
      assert.equal(response.status, 409);
      const body = await response.json() as Built;
      assert.match(String(body.error), /expected authenticated listing candidate/);
      assert.equal(body.tx, undefined);
      assert.equal(body.listing, undefined);
    });
  });
}

test("an authenticated listing under the legacy program name is recovered without a second write", async () => {
  await withOccupancy(
    "legacy-recovery",
    (v1) => ({ name: legacyProgramName("legacy-recovery", 1), data: v1.listing }),
    async ({ post }) => {
      const response = await post();
      assert.equal(response.status, 200);
      const body = await response.json() as Built;
      assert.equal(body.exists, true);
      assert.equal(body.tx, null, "the recovered version is not written again");
      assert.equal(body.programName, legacyProgramName("legacy-recovery", 1), "the report names the program that is on chain");
    },
  );
});

test("a legacy program name for another version leaves this version free to publish", async () => {
  await withOccupancy(
    "legacy-other-version",
    (v1) => ({ name: legacyProgramName("legacy-other-version", 2), data: v1.listing }),
    async ({ post, queries }) => {
      const response = await post();
      assert.equal(response.status, 200);
      const body = await response.json() as Built;
      assert.equal(body.exists, false);
      assert.ok(body.tx, "an unprepared version is still published");
      assert.equal(body.tx.content.data[1].programName, body.programName);
      assert.notEqual(body.programName, legacyProgramName("legacy-other-version", 1), "new programs do not use the legacy name");
      assert.ok(queries.includes(legacyProgramName("legacy-other-version", 1)), "the legacy name is looked up");
    },
    false,
  );
});

/** Sign a fresh request for `serviceId`, then send it while its legacy-name lookup fails; records nonce reads. */
async function withLegacyLookupDown(serviceId: string, check: (signed: Record<string, unknown>, nonceReads: string[]) => Promise<void>) {
  const input = { ...base, serviceId };
  const identity = await (await POST(request(input))).json() as { identityMessage: string; identityPresentedAt: number; listingVersion: number };
  const finalInput = { ...input, listingVersion: identity.listingVersion,
    identityPresentedAt: identity.identityPresentedAt, identitySignature: walletHex(identity.identityMessage) };
  let legacyDown = false;
  const nonceReads: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const deployment = deploymentReply(init);
    if (deployment) return deployment;
    if (init?.method !== "POST") return new Response(null, { status: 404 });
    const call = (JSON.parse(String(init.body)) as { params?: Array<{ message?: string; data?: { query?: string } }> }).params?.[0];
    if (call?.message === "getAddressNonce") nonceReads.push(call.message);
    if (call?.message === "searchStoragePrograms" && legacyDown && call.data?.query === legacyProgramName(serviceId, 1)) {
      return new Response("unavailable", { status: 503 });
    }
    return Response.json({ result: 200, response: call?.message === "searchStoragePrograms" ? [] : 0 });
  };
  try {
    const preview = await (await POST(request(finalInput))).json() as { message: string };
    legacyDown = true;
    await check({ ...finalInput, listingSignature: walletHex(preview.message) }, nonceReads);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("an unreadable legacy-name lookup withholds the create transaction", async () => {
  await withLegacyLookupDown(base.serviceId, async (signed, nonceReads) => {
    const response = await createBuildListingPost(signedRailSnapshot)(request(signed));
    assert.equal(response.status, 503);
    const body = await response.json() as Built;
    assert.match(String(body.error), /could not safely determine whether this listing version already exists/);
    assert.equal(body.tx, undefined, "a legacy name that cannot be read may still hold this version");
    assert.deepEqual(nonceReads, [], "no write nonce is requested");
  });
});

test("a configured resolver decides occupancy when only the legacy-name lookup is unreadable", async () => {
  await withLegacyLookupDown("legacy-down-resolver", async (signed, nonceReads) => {
    const withheld = await createBuildListingPost(signedRailSnapshot,
      async () => ({ status: "indeterminate", reason: "history index is incomplete" }))(request(signed));
    assert.equal(withheld.status, 503);
    assert.match(String((await withheld.json() as Built).error), /history index is incomplete/);
    assert.deepEqual(nonceReads, []);
    const created = await POST(request(signed));
    assert.equal(created.status, 200);
    assert.ok((await created.json() as Built).tx, "a complete empty resolver result permits the create");
    assert.equal(nonceReads.length, 1);
  });
});
