import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";
// First: the store must open in a fresh directory, never the checkout's data/.
import "./fixtures/isolated-data-dir.js";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed } from "@kynesyslabs/dacs/crypto";
import { artifactHash, signedScope } from "../src/catalog/evidenceGraph.js";
import { indexRegistration } from "../src/catalog/indexer.js";
import { REVOCATION_VERIFICATIONS_PER_PASS } from "../src/catalog/listingVerification.js";
import { admitRevocationCandidates, loadScanState, saveScanState } from "../src/catalog/store.js";
import type { Registration } from "../src/catalog/types.js";
import { type Obj, bindingFor, dids, installAgreement, locator, maps, registeredDeal, seeds, sign, vector }
  from "./fixtures/current-evidence.js";
import { indexWithCommitments } from "./fixtures/commitment-proof.js";

const seller = dids[1];
const owner = `0x${seller.slice(-64)}`;
const thirdParty = `0x${"e".repeat(64)}`;
const offline = async (): Promise<never> => { throw new Error("identity unavailable"); };
/** Past the longest (60 s) candidate retry backoff. */
const AFTER_BACKOFF = 61_000;

/** How the node answers a marker read; unlisted locators are served from `maps`, or NOT_FOUND. */
type MarkerReply = "not-found" | "access-denied" | "transport-failure" | "node-error"
  | "not-an-object" | "array-data" | "null-data";
/** Successful storage envelopes whose `data` cannot be an artifact object. */
const nonObjectData = new Map<MarkerReply, unknown>([["not-an-object", "not-an-object"], ["array-data", []], ["null-data", null]]);
const replies = new Map<string, MarkerReply>();

function serveStorage(t: TestContext): void {
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const at = String(input).split("/").pop() ?? "";
    const reply = replies.get(at);
    if (reply === "transport-failure") throw new TypeError("fetch failed");
    if (reply === "access-denied") return Response.json({ success: false, errorCode: "PERMISSION_DENIED" }, { status: 403 });
    if (reply === "node-error") return new Response(null, { status: 503 });
    if (reply && nonObjectData.has(reply)) return Response.json({ success: true, owner, data: nonObjectData.get(reply) });
    const data = reply === "not-found" ? undefined : maps.get(at);
    return data ? Response.json({ success: true, owner, data })
      : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
  });
}

/** The seller's own current Listing under a test-unique ID, anchored and readable. */
async function ownListing(listingId: string, offset: number) {
  replies.clear();
  const fixture = await vector(`${listingId}-job`, offset);
  const scope = signedScope(fixture.listing, "listing");
  scope.listingId = listingId;
  fixture.listing = { ...scope, signature: await sign(scope, "listing", 1) };
  maps.set(fixture.locators.listing, fixture.listing);
  const registration: Registration = { primaryClaim: seller, displayName: "seller", listingAnchors: [fixture.locators.listing] };
  return { fixture, registration, hash: artifactHash(fixture.listing, "listing") };
}

const index = (registration: Registration) => indexRegistration(registration, undefined, offline);

async function signedMarker(listingId: string, listingContentHash: string): Promise<Obj> {
  const scope = { listingId, listingVersion: 1, listingContentHash, revokedAt: 1 };
  const value = Buffer.from(await ed25519Sign(Buffer.from(`dacs-revocation:v1:${contentHash(scope)}`),
    privateKeyFromSeed(seeds[1]))).toString("base64url");
  return { ...scope, signature: { algorithm: "ed25519", signer: seller, value } };
}
/** Marker-shaped bytes whose signature does not verify: a readable, rejected candidate. */
const invalidMarker: Obj = { revocationVersion: "1", signature: "invalid" };

test("an unread owner marker holds the Listing until a read settles it, by reply kind", async (t) => {
  serveStorage(t);
  const outcomes: Array<[MarkerReply | "readable-invalid", boolean]> = [
    ["not-found", true], ["access-denied", true], ["transport-failure", true], ["node-error", true],
    ["not-an-object", true], ["array-data", true], ["null-data", true], ["readable-invalid", false],
  ];
  for (const [offset, [reply, held]] of outcomes.map((outcome, n) => [4000 + n * 20, outcome] as const)) {
    const { registration, hash } = await ownListing(`owner-reply-${reply}`, offset);
    const markerAt = locator(offset + 10);
    admitRevocationCandidates(hash, [{ locator: markerAt, owner }]);
    if (reply === "readable-invalid") maps.set(markerAt, invalidMarker);
    else replies.set(markerAt, reply);
    const record = await index(registration);
    assert.deepEqual(record.listings.map((listing) => listing.status), held ? [] : ["active"], reply);
  }
});

test("an unreadable owner marker keeps holding the Listing on a pass inside its retry backoff (rvc C-1)", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  serveStorage(t);
  for (const [n, reply] of (["not-found", "not-an-object"] as const).entries()) {
    const offset = 4200 + n * 40;
    const { registration, hash } = await ownListing(`owner-marker-backoff-${reply}`, offset);
    const markerAt = locator(offset + 10);
    admitRevocationCandidates(hash, [{ locator: markerAt, owner }]);
    replies.set(markerAt, reply);
    assert.equal((await index(registration)).listings.length, 0, `${reply}: the first pass cannot read the marker`);
    now += 500;
    assert.equal((await index(registration)).listings.length, 0, `${reply}: the marker is skipped inside its backoff but still holds`);
    now += AFTER_BACKOFF;
    replies.delete(markerAt);
    maps.set(markerAt, invalidMarker);
    assert.equal((await index(registration)).listings.length, 1, `${reply}: a settled read releases the hold`);
  }
});

test("an owner marker still queued beyond the per-pass limit holds the Listing until it is read", async (t) => {
  serveStorage(t);
  const { registration, hash } = await ownListing("owner-marker-queued", 4300);
  const markers = Array.from({ length: REVOCATION_VERIFICATIONS_PER_PASS + 1 }, (_, n) => locator(4400 + n));
  admitRevocationCandidates(hash, markers.map((at) => ({ locator: at, owner })));
  for (const at of markers) maps.set(at, invalidMarker);
  assert.equal((await index(registration)).listings.length, 0, "the never-selected owner marker holds");
  assert.equal((await index(registration)).listings.length, 1, "reading the last one releases the hold");
});

test("a previously verified marker that can no longer be read holds the Listing; its valid bytes revoke it", async (t) => {
  serveStorage(t);
  const cases: Array<MarkerReply | "valid"> = ["not-found", "access-denied", "transport-failure", "not-an-object", "array-data", "valid"];
  for (const [n, reply] of cases.entries()) {
    const offset = 4500 + n * 15;
    const listingId = `known-marker-${reply}`;
    const { registration, hash } = await ownListing(listingId, offset);
    const markerAt = locator(offset + 10);
    const state = loadScanState();
    saveScanState({ ...state, verifiedRevocations: { ...state.verifiedRevocations, [hash]: [markerAt] } });
    if (reply === "valid") maps.set(markerAt, await signedMarker(listingId, hash));
    else replies.set(markerAt, reply);
    const record = await index(registration);
    assert.deepEqual(record.listings.map((listing) => listing.status), reply === "valid" ? ["revoked"] : [], reply);
  }
});

test("an unreadable candidate anchored by someone else cannot hold the Listing", async (t) => {
  serveStorage(t);
  for (const [n, reply] of (["not-found", "node-error", "not-an-object"] as const).entries()) {
    const offset = 4600 + n * 20;
    const { registration, hash } = await ownListing(`third-party-${reply}`, offset);
    const markerAt = locator(offset + 10);
    admitRevocationCandidates(hash, [{ locator: markerAt, owner: thirdParty }]);
    replies.set(markerAt, reply);
    assert.deepEqual((await index(registration)).listings.map((listing) => listing.status), ["active"], reply);
  }
});

test("a held Listing keeps its authentically committed deal history", async (t) => {
  serveStorage(t);
  const { fixture, registration, hash } = await ownListing("held-history", 4700);
  const listingRef = { listingId: "held-history", version: 1, contentHash: hash };
  fixture.buyerBundle = { ...fixture.buyerBundle, listingRef };
  fixture.sellerBundle = { ...fixture.sellerBundle, listingRef };
  await installAgreement(fixture, { ...signedScope(fixture.agreement, "agreement"), listingRef });
  const deal = registeredDeal("held-history-job", fixture.locators.buyer, fixture.locators.seller);
  const markerAt = locator(4710);
  admitRevocationCandidates(hash, [{ locator: markerAt, owner }]);
  const record = await indexWithCommitments({ ...registration, deals: [deal], bundleBindings: [
    await bindingFor(deal.jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
    await bindingFor(deal.jobId, "seller", fixture.locators.seller, fixture.sellerBundle, 1),
  ] }, undefined, offline);
  assert.deepEqual(record.listings, [], "the unread owner marker holds discovery");
  assert.equal(record.deals[0].refsVerified, true, "an unsettled withdrawal does not withhold committed credit");
  assert.equal(record.reputation.completed, 1);
});

test("the owner hold survives a restart inside the retry backoff and a later readable rejection releases it", async (t) => {
  // Schedule the backoff ahead of the restarted process's real clock, so its pass falls inside it.
  let now = Date.now() + 10 * 60_000;
  t.mock.method(Date, "now", () => now);
  serveStorage(t);
  const { fixture, registration, hash } = await ownListing("owner-marker-restart", 4800);
  const markerAt = locator(4810);
  admitRevocationCandidates(hash, [{ locator: markerAt, owner }]);
  assert.equal((await index(registration)).listings.length, 0);
  // The restarted process would release the Listing if it read these bytes, so a hold proves it skipped them.
  const restarted = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    const { indexRegistration } = await import("./src/catalog/indexer.ts");
    const programs = ${JSON.stringify({ [fixture.locators.listing]: fixture.listing, [markerAt]: invalidMarker })};
    globalThis.fetch = async (input) => Response.json({ success: true, owner: ${JSON.stringify(owner)},
      data: programs[String(input).split("/").pop()] });
    const record = await indexRegistration(${JSON.stringify(registration)}, undefined, async () => { throw new Error("offline"); });
    assert.equal(record.listings.length, 0);
  `], { encoding: "utf8", env: process.env });
  assert.equal(restarted.status, 0, restarted.stderr);
  now += AFTER_BACKOFF;
  maps.set(markerAt, invalidMarker);
  assert.equal((await index(registration)).listings.length, 1, "a readable rejection after restart releases the hold");
});
