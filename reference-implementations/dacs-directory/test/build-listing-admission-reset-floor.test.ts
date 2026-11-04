import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { PINNED_DEMOS_CHAIN_IDENTITY, PINNED_DEMOS_NODE_BUILDS } from "../src/catalog/nodeDeployment.js";
import { signedRailSnapshot } from "./signed-rail-snapshot.js";

// A store from before the band-floor rule holds version 1 of a negotiable Listing
// whose lower bound rounds to zero (1 x 99%). That rule makes admission refuse it, so
// the admission reset must run again, withhold the row and keep version 1 as the floor:
// the seller's corrected Listing is then version 2, not a 409 for the taken version 1.
const directory = mkdtempSync(join(tmpdir(), "dacs-build-listing-reset-floor-"));
process.env.DACS_DIRECTORY_DATA = directory;
test.after(() => rmSync(directory, { recursive: true, force: true }));

const seed = Uint8Array.from(Buffer.alloc(32, 17));
const privateKey = privateKeyFromSeed(seed);
const keyHex = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex");
const claim = `did:demos:agent:${keyHex}`;
const listingId = "zero-floor-band";
const seeded = new Database(join(directory, "directory.sqlite"));
seeded.exec("CREATE TABLE kv_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
const put = seeded.prepare("INSERT INTO kv_state VALUES (?, ?, 0)");
for (const [key, value] of Object.entries({
  "schema-version": 1, "sr2-anchor-schema-version": 2, "listing-admission-schema-version": 1,
  "catalog": { catalogVersion: "1", generatedAt: 1, sellers: [{ primaryClaim: claim, displayName: "Band seller", cci: [],
    listings: [{
      listingId, version: 1, contentHash: "1".repeat(64),
      anchor: { kind: "storage-program", locator: `stor-${"1".repeat(40)}` },
      seller: { primaryClaim: claim, displayName: "Band seller" },
      offering: { title: listingId, category: "services.test", tags: [] },
      pricing: { kind: "negotiable", bandCenter: { amount: "1", currency: "DEM" }, minPct: 99, maxPct: 20 },
      status: "active", catalogObservedAt: 1,
    }], deals: [], reputation: { completed: 0, totalAgreements: 0, completionRate: null }, registeredAt: 1, lastIndexedAt: 1 }] },
  "registrations": [], "scan-state": { lastSeenTxId: 0, listings: {}, deals: {} },
})) put.run(key, JSON.stringify(value));
seeded.close();

const store = await import("../src/catalog/store.js");
const { createBuildListingPost } = await import("../src/catalog/buildListing.js");
const POST = createBuildListingPost(signedRailSnapshot);

const cleanBuild = { commit: PINNED_DEMOS_NODE_BUILDS[0], dirty: false, builtAt: "2026-10-14T16:45:24Z" };
const chainReply = (init: RequestInit | undefined): Response => {
  const call = (JSON.parse(String(init?.body)).params?.[0] ?? {}) as { message?: string; data?: { blockNumber?: number } };
  if (call.message === "getNetworkInfo") return Response.json({ result: 200, response: { nodeVersion: cleanBuild } });
  if (call.message === "getBlockByNumber" && call.data?.blockNumber === 0) return Response.json({ result: 400, response: "error" });
  if (call.message === "getBlockByNumber" && call.data?.blockNumber === 1) {
    return Response.json({
      result: 200,
      response: { id: 2, number: 1, status: "confirmed", hash: "12".repeat(32), content: { previousHash: PINNED_DEMOS_CHAIN_IDENTITY, timestamp: 1 } },
    });
  }
  return Response.json({ result: 200, response: call.message === "searchStoragePrograms" ? [] : 0 });
};
const input = {
  claim, serviceId: listingId, name: "Band service", description: "A negotiable Listing republished with a valid band.",
  rails: ["demos-native:DEM"], delivery: ["deliver-storage-program"],
  pricing: { kind: "negotiable", amount: "1", currency: "DEM", minPct: 50, maxPct: 20 },
};
const request = (body: Record<string, unknown>) => new NextRequest("https://directory.example/api/dacs/build-listing", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const walletHex = (message: string) => Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKey)).toString("hex");

test("a zero-floor band stored before the rule is withheld and its version is kept for the republish", async (t) => {
  assert.deepEqual(store.loadCatalog().sellers.flatMap((seller) => seller.listings), [], "the reset withheld the row");
  assert.equal(store.listingVersionFloor(claim, listingId), 1, "the withheld row's version is the floor");
  t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => chainReply(init));

  const first = await POST(request(input));
  assert.equal(first.status, 200, await first.clone().text());
  const identity = await first.json() as { identityMessage: string; identityPresentedAt: number; listingVersion: number };
  assert.equal(identity.listingVersion, 2, "the republish is numbered after the withheld version");
  const second = await POST(request({ ...input, listingVersion: 2, identityPresentedAt: identity.identityPresentedAt,
    identitySignature: walletHex(identity.identityMessage) }));
  assert.equal(second.status, 200, await second.clone().text());
  assert.equal(((await second.json()) as { listing: { listingVersion: number } }).listing.listingVersion, 2);
});
