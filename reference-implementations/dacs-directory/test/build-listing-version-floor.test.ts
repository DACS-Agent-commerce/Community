import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { PINNED_DEMOS_CHAIN_IDENTITY, PINNED_DEMOS_NODE_BUILDS } from "../src/catalog/nodeDeployment.js";
import { signedRailSnapshot } from "./signed-rail-snapshot.js";
import { emptyListingOccupancy } from "./fixtures/listing-occupancy.js";

// The catalog listed versions 1 and 2 of this Listing before the admission
// reset; the reset keeps version 2 as the floor and removes both rows.
const directory = mkdtempSync(join(tmpdir(), "dacs-build-listing-floor-"));
process.env.DACS_DIRECTORY_DATA = directory;
test.after(() => rmSync(directory, { recursive: true, force: true }));

const seed = Uint8Array.from(Buffer.alloc(32, 16));
const privateKey = privateKeyFromSeed(seed);
const keyHex = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex");
const claim = `did:demos:agent:${keyHex}`;
const listingId = "floor-probe";
const summary = (version: number) => ({
  listingId, version, contentHash: String(version).repeat(64),
  anchor: { kind: "storage-program", locator: `stor-${String(version).repeat(40)}` },
  seller: { primaryClaim: claim, displayName: "Floor seller" },
  offering: { title: listingId, category: "services.test", tags: [] }, pricing: {}, status: "active", catalogObservedAt: 1,
});
const seeded = new Database(join(directory, "directory.sqlite"));
seeded.exec("CREATE TABLE kv_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
const put = seeded.prepare("INSERT INTO kv_state VALUES (?, ?, 0)");
for (const [key, value] of Object.entries({
  "schema-version": 1, "sr2-anchor-schema-version": 2,
  "catalog": { catalogVersion: "1", generatedAt: 1, sellers: [{ primaryClaim: claim, displayName: "Floor seller", cci: [],
    listings: [summary(1), summary(2)], deals: [], reputation: { completed: 0, totalAgreements: 0, completionRate: null },
    registeredAt: 1, lastIndexedAt: 1 }] },
  "registrations": [], "scan-state": { lastSeenTxId: 0, listings: {}, deals: {} },
})) put.run(key, JSON.stringify(value));
seeded.close();

const store = await import("../src/catalog/store.js");
const { createBuildListingPost } = await import("../src/catalog/buildListing.js");
const POST = createBuildListingPost(signedRailSnapshot, emptyListingOccupancy);

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

const input = {
  claim, serviceId: listingId, name: "Floor service", description: "A Listing whose earlier versions an admission reset withheld.",
  rails: ["ap2:stripe-paymentintents"], delivery: ["deliver-storage-program"],
  pricing: { kind: "metered", amount: "0.02", currency: "USD", unit: "API call", minTotal: "1" },
};
const request = (body: Record<string, unknown>) => new NextRequest("https://directory.example/api/dacs/build-listing", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const walletHex = (message: string) => Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKey)).toString("hex");

type Built = { listing: Record<string, unknown>; message?: string; programName: string; exists: boolean; contentHash: string;
  tx: { content: { data: [string, { data: Record<string, unknown> }] } } | null; error?: string };

test("after an admission reset the builder offers the version after the floor and never creates a floor-held one", async (t) => {
  assert.equal(store.listingVersionFloor(claim, listingId), 2);
  assert.deepEqual(store.loadCatalog().sellers.flatMap((seller) => seller.listings), [], "the reset removed the rows");
  let occupied: { name: string; address: string; data: Record<string, unknown> } | undefined;
  const nonceReads: number[] = [];
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const deployment = deploymentReply(init);
    if (deployment) return deployment;
    if (init?.method === "POST") {
      const call = JSON.parse(String(init.body)).params?.[0] as { message?: string; data?: { query?: string } };
      if (call.message === "getAddressNonce") nonceReads.push(1);
      return Response.json({ result: 200, response: call.message !== "searchStoragePrograms" ? 0
        : occupied && call.data?.query === occupied.name ? [{ storageAddress: occupied.address, programName: occupied.name }] : [] });
    }
    return occupied && String(url).endsWith(occupied.address)
      ? Response.json({ success: true, data: occupied.data, owner: `0x${keyHex}`, programName: occupied.name })
      : new Response(null, { status: 404 });
  });
  const identity = await (await POST(request(input))).json() as { identityMessage: string; identityPresentedAt: number; listingVersion: number };
  assert.equal(identity.listingVersion, 3, "the first step numbers the version after the floor");
  const at = (listingVersion: number) => ({ ...input, listingVersion,
    identityPresentedAt: identity.identityPresentedAt, identitySignature: walletHex(identity.identityMessage) });

  const preview = await (await POST(request(at(3)))).json() as Built;
  assert.equal(preview.listing.listingVersion, 3);
  assert.equal(preview.tx, null);
  const built = await (await POST(request({ ...at(3), listingSignature: walletHex(String(preview.message)) }))).json() as Built;
  assert.ok(built.tx, "version 3 is created");
  assert.equal(built.tx.content.data[1].data.listingVersion, 3);

  nonceReads.length = 0;
  for (const listingVersion of [1, 2]) {
    for (const body of [at(listingVersion), { ...at(listingVersion), listingSignature: walletHex(String(preview.message)) }]) {
      const response = await POST(request(body));
      assert.equal(response.status, 409, `a floor-held version ${listingVersion} absent under this producer's names`);
      const refused = await response.json() as Built;
      assert.match(String(refused.error), /already published this version/);
      assert.equal(refused.tx, undefined);
    }
  }
  assert.deepEqual(nonceReads, [], "no write nonce is read for a taken version");
  assert.equal((await POST(request(at(4)))).status, 400, "a version past the next one is refused");

  // Version 2 of this Listing, as its program holds it.
  const { signature, ...unsigned } = built.listing;
  const v2 = { ...unsigned, listingVersion: 2 };
  const v2Signed = { ...v2, signature: { ...(signature as Record<string, unknown>),
    value: Buffer.from(ed25519Sign(Buffer.from(`dacs-listing:v1:${contentHash(v2)}`, "utf8"), privateKey)).toString("base64url") } };
  occupied = { name: built.programName.replace(/v3$/, "v2"), address: `stor-${"2".repeat(40)}`, data: v2Signed };
  const recovered = await (await POST(request(at(2)))).json() as Built;
  assert.equal(recovered.exists, true, "a floor-held version its program still holds is recovered");
  assert.equal(recovered.tx, null);
  assert.deepEqual(recovered.listing, v2Signed);
  assert.equal(recovered.contentHash, contentHash(v2));
});
