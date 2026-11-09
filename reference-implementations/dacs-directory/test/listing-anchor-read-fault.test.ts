import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
// First: the store must open in a fresh directory, never the checkout's data/.
import "./fixtures/isolated-data-dir.js";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed } from "@kynesyslabs/dacs/crypto";
import { NextRequest } from "next/server";
import { GET as listings } from "../app/api/dacs/listings/route.js";
import { MAX_ARTIFACT_BYTES } from "../src/catalog/artifactLimits.js";
import { artifactHash, signedScope } from "../src/catalog/evidenceGraph.js";
import { indexRegistration } from "../src/catalog/indexer.js";
import { reindexAll } from "../src/catalog/reindexCore.js";
import {
  admitRevocationCandidates, loadCatalog, loadScanState, recordListingRejection, saveRegistrations, saveScanState,
} from "../src/catalog/store.js";
import type { Registration, SellerRecord } from "../src/catalog/types.js";
import { dids, locator, maps, seeds, sign, vector } from "./fixtures/current-evidence.js";
import { pinnedNodeAnswer } from "./fixtures/pinned-node.js";

const seller = dids[1];
const owner = `0x${seller.slice(-64)}`;
const offline = async (): Promise<never> => { throw new Error("identity unavailable"); };
const OBSERVED_AT = 1_000_000;
const INDEXED_AGAIN_AT = OBSERVED_AT + 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const OTHER_BYTES_HASH = "f".repeat(64);
/** The injected clock: every test moves it by assigning, and the mocked `Date.now` reads it. */
let clockMs = OBSERVED_AT;

/** How storage answers a read of one anchor; an unlisted anchor is served from `maps`, or NOT_FOUND. */
type StorageFault = "http-502" | "timeout" | "transport-failure" | "access-denied" | "unauthenticated" | "unqualified-404"
  | "unconfirmed-read" | "not-found" | "not-an-object" | "not-a-listing" | "duplicate-member-value" | "over-limit-value";
/** Faults that say nothing about the anchor and may pass on a later read. */
const transientFaults: StorageFault[] = ["http-502", "timeout", "transport-failure", "unconfirmed-read"];
/** The node or a proxy answered with a 4xx: the same read will not pass by itself. */
const refusalFaults: StorageFault[] = ["access-denied", "unauthenticated", "unqualified-404"];
const unavailableFaults: StorageFault[] = [...transientFaults, ...refusalFaults];
const faults = new Map<string, StorageFault>();
/** The transactions the node returns for a history read; empty unless a test sets a chain tip. */
let nodeTransactions: Array<{ id: number }> = [];

function storageAnswer(at: string): Response {
  const fault = faults.get(at);
  if (fault === "timeout") throw Object.assign(new Error("deadline passed"), { name: "TimeoutError" });
  if (fault === "transport-failure") throw new TypeError("fetch failed");
  if (fault === "http-502") return Response.json({ error: "storage unavailable" }, { status: 502 });
  if (fault === "access-denied") return Response.json({ success: false, errorCode: "PERMISSION_DENIED" }, { status: 403 });
  if (fault === "unauthenticated") return new Response(null, { status: 401 });
  if (fault === "unqualified-404") return new Response(null, { status: 404 });
  if (fault === "unconfirmed-read") return Response.json({ success: false });
  if (fault === "not-an-object") return Response.json({ success: true, owner, data: [] });
  if (fault === "duplicate-member-value") {
    return new Response(`{"success":true,"owner":"${owner}","data":{"listingId":"a","listingId":"b"}}`);
  }
  if (fault === "over-limit-value") return Response.json({ success: true, owner, data: { padding: "x".repeat(MAX_ARTIFACT_BYTES) } });
  const data = fault === "not-a-listing" ? { notAListing: true } : fault === "not-found" ? undefined : maps.get(at);
  return data ? Response.json({ success: true, owner, data })
    : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
}

/** The newest page of history only: a read from any older cursor finds the history exhausted. */
const historyPage = (body: string): Array<{ id: number }> =>
  JSON.parse(body).params?.[0]?.data?.start === "latest" ? nodeTransactions : [];

function serveStorage(t: TestContext): void {
  nodeTransactions = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    init?.body ? pinnedNodeAnswer(init.body) ?? Response.json({ result: 200, response: historyPage(String(init.body)) })
      : storageAnswer(String(input).split("/").pop() ?? ""));
}

/** A signed Listing of the seller under a test-unique ID, readable at its own anchor; `notAfter` is signed into its validity. */
async function anchoredListing(listingId: string, offset: number, version = 1, notAfter?: number) {
  const fixture = await vector(`${listingId}-v${version}-job`, offset);
  const scope = signedScope(fixture.listing, "listing");
  scope.listingId = listingId;
  scope.listingVersion = version;
  if (notAfter !== undefined) scope.validity = { notBefore: 1, notAfter };
  scope.acceptedRails = [{ railId: "demos-native:DEM" }];
  scope.pipeline = [
    { kind: "negotiate-fixed-price" }, { kind: "commit-agreement" },
    { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }, { kind: "deliver-attested-payload" },
  ];
  const listing = { ...scope, signature: await sign(scope, "listing", 1) };
  maps.set(fixture.locators.listing, listing);
  return { anchor: fixture.locators.listing, listing };
}

const registrationFor = (listingAnchors: string[], listingContentHashes?: Record<string, string>): Registration =>
  ({ primaryClaim: seller, displayName: "seller", listingAnchors, ...(listingContentHashes ? { listingContentHashes } : {}) });

/** The seller as indexed at OBSERVED_AT with every read working. */
async function indexedWhileReadable(t: TestContext, registration: Registration): Promise<SellerRecord> {
  faults.clear();
  serveStorage(t);
  clockMs = OBSERVED_AT;
  t.mock.method(Date, "now", () => clockMs);
  const record = await indexRegistration(registration, undefined, offline);
  assert.equal(record.listings.length, 1, "the Listing is indexed while its anchor is readable");
  clockMs = INDEXED_AGAIN_AT;
  return record;
}

test("an unavailable anchor read keeps the prior Listing, by transient reply kind", async (t) => {
  const { anchor } = await anchoredListing("kept-by-reply-kind", 7000);
  const registration = registrationFor([anchor]);
  const prior = await indexedWhileReadable(t, registration);
  for (const fault of transientFaults) {
    faults.set(anchor, fault);
    const record = await indexRegistration(registration, prior, offline);
    assert.deepEqual(record.listings.map(({ listingId, status }) => ({ listingId, status })),
      [{ listingId: "kept-by-reply-kind", status: "active" }], fault);
  }
});

test("a kept Listing keeps the time the catalog last read it", async (t) => {
  const { anchor } = await anchoredListing("kept-observed-at", 7020);
  const registration = registrationFor([anchor]);
  const prior = await indexedWhileReadable(t, registration);
  faults.set(anchor, "http-502");
  const record = await indexRegistration(registration, prior, offline);
  assert.equal(record.lastIndexedAt, INDEXED_AGAIN_AT);
  assert.deepEqual(record.listings.map((listing) => listing.catalogObservedAt), [OBSERVED_AT]);
});

test("a gone or replaced anchor still drops the prior Listing", async (t) => {
  const { anchor } = await anchoredListing("dropped-when-gone", 7040);
  const registration = registrationFor([anchor]);
  const prior = await indexedWhileReadable(t, registration);
  for (const fault of ["not-found", "not-an-object", "not-a-listing"] as const) {
    faults.set(anchor, fault);
    assert.deepEqual((await indexRegistration(registration, prior, offline)).listings, [], fault);
  }
});

test("a 4xx answer from storage drops the prior Listing, as before", async (t) => {
  const { anchor } = await anchoredListing("dropped-when-refused", 7050);
  const registration = registrationFor([anchor]);
  const prior = await indexedWhileReadable(t, registration);
  for (const fault of refusalFaults) {
    faults.set(anchor, fault);
    assert.deepEqual((await indexRegistration(registration, prior, offline)).listings, [], fault);
  }
});

test("a 200 reply whose stored value is refused drops the prior Listing, by reason", async (t) => {
  const { anchor } = await anchoredListing("dropped-when-value-refused", 7055);
  const registration = registrationFor([anchor]);
  const prior = await indexedWhileReadable(t, registration);
  for (const fault of ["duplicate-member-value", "over-limit-value"] as const) {
    faults.set(anchor, fault);
    assert.deepEqual((await indexRegistration(registration, prior, offline)).listings, [], fault);
  }
});

test("a kept Listing is dropped once the catalog last read its anchor more than 24 hours ago", async (t) => {
  const { anchor } = await anchoredListing("dropped-when-stale", 7052);
  const registration = registrationFor([anchor]);
  const prior = await indexedWhileReadable(t, registration);
  faults.set(anchor, "http-502");
  clockMs = OBSERVED_AT + DAY_MS;
  assert.equal((await indexRegistration(registration, prior, offline)).listings.length, 1, "kept at exactly 24 hours");
  clockMs = OBSERVED_AT + DAY_MS + 1;
  assert.deepEqual((await indexRegistration(registration, prior, offline)).listings, [], "dropped after 24 hours");
});

/** A withdrawal of the Listing signed by the seller's key, readable at its own anchor, and queued as a candidate for it, anchored by `anchoredBy`. */
function anchoredWithdrawal(listing: Record<string, unknown>, listingId: string, offset: number, anchoredBy = owner): void {
  const listingContentHash = artifactHash(listing, "listing");
  const scope = { listingId, listingVersion: 1, listingContentHash, revokedAt: OBSERVED_AT + 1 };
  const value = Buffer.from(ed25519Sign(Buffer.from(`dacs-revocation:v1:${contentHash(scope)}`), privateKeyFromSeed(seeds[1]))).toString("base64url");
  const marker = locator(offset);
  maps.set(marker, { ...scope, signature: { algorithm: "ed25519", signer: seller, value } });
  admitRevocationCandidates(listingContentHash, [{ locator: marker, owner: anchoredBy }]);
}

test("a withdrawal the seller anchored during an outage is not published as an active kept Listing", async (t) => {
  const { anchor, listing } = await anchoredListing("dropped-when-withdrawal-pending", 7200);
  const registration = registrationFor([anchor]);
  const prior = await indexedWhileReadable(t, registration);
  anchoredWithdrawal(listing, "dropped-when-withdrawal-pending", 7210);
  faults.set(anchor, "http-502");
  assert.deepEqual((await indexRegistration(registration, prior, offline)).listings, []);
});

test("a withdrawal a different account anchored during an outage is not published as an active kept Listing", async (t) => {
  const { anchor, listing } = await anchoredListing("dropped-when-relayed-withdrawal-pending", 7240);
  const registration = registrationFor([anchor]);
  const prior = await indexedWhileReadable(t, registration);
  anchoredWithdrawal(listing, "dropped-when-relayed-withdrawal-pending", 7250, `0x${"ab".repeat(32)}`);
  faults.set(anchor, "http-502");
  assert.deepEqual((await indexRegistration(registration, prior, offline)).listings, []);
});

test("a retained withdrawal keeps a Listing from being published as an active kept copy", async (t) => {
  const { anchor, listing } = await anchoredListing("dropped-when-withdrawal-retained", 7220);
  const registration = registrationFor([anchor]);
  const prior = await indexedWhileReadable(t, registration);
  anchoredWithdrawal(listing, "dropped-when-withdrawal-retained", 7230);
  const whileReadable = await indexRegistration(registration, prior, offline);
  assert.deepEqual(whileReadable.listings.map((entry) => entry.status), ["revoked"], "the withdrawal is verified and retained");
  faults.set(anchor, "http-502");
  assert.deepEqual((await indexRegistration(registration, prior, offline)).listings, []);
});

test("a kept Listing is dropped once its signed notAfter has passed", async (t) => {
  const { anchor } = await anchoredListing("dropped-when-expired", 7240, 1, OBSERVED_AT + 30_000);
  const registration = registrationFor([anchor]);
  const prior = await indexedWhileReadable(t, registration);
  faults.set(anchor, "http-502");
  assert.deepEqual((await indexRegistration(registration, prior, offline)).listings, []);
});

test("a kept Listing stays while its signed notAfter is in the future", async (t) => {
  const { anchor } = await anchoredListing("kept-before-expiry", 7250, 1, INDEXED_AGAIN_AT + 1_000);
  const registration = registrationFor([anchor]);
  const prior = await indexedWhileReadable(t, registration);
  faults.set(anchor, "http-502");
  assert.deepEqual((await indexRegistration(registration, prior, offline)).listings.map((entry) => entry.status), ["active"]);
});

test("a kept Listing saved without its notAfter is dropped, as it cannot show it is still in force", async (t) => {
  const { anchor } = await anchoredListing("dropped-without-saved-notafter", 7260);
  const registration = registrationFor([anchor]);
  const { keptListingFacts: _facts, ...savedByEarlierBuild } = await indexedWhileReadable(t, registration);
  faults.set(anchor, "http-502");
  assert.deepEqual((await indexRegistration(registration, savedByEarlierBuild, offline)).listings, []);
});

test("a failed read with no prior copy publishes nothing", async (t) => {
  const { anchor } = await anchoredListing("never-indexed", 7060);
  serveStorage(t);
  for (const fault of unavailableFaults) {
    faults.set(anchor, fault);
    assert.deepEqual((await indexRegistration(registrationFor([anchor]), undefined, offline)).listings, [], fault);
  }
});

test("a failed read of an anchor with no prior copy adds nothing beside the Listing kept for another anchor", async (t) => {
  const kept = await anchoredListing("kept-beside-unindexed", 7070);
  const prior = await indexedWhileReadable(t, registrationFor([kept.anchor]));
  const unindexed = (await anchoredListing("kept-beside-unindexed-new", 7075)).anchor;
  faults.set(kept.anchor, "http-502");
  faults.set(unindexed, "http-502");
  const record = await indexRegistration(registrationFor([kept.anchor, unindexed]), prior, offline);
  assert.deepEqual(record.listings.map((listing) => listing.anchor.locator), [kept.anchor]);
});

test("a signed declaration of other bytes still drops the prior Listing on an unavailable read", async (t) => {
  const { anchor } = await anchoredListing("dropped-when-declared-replaced", 7080);
  const prior = await indexedWhileReadable(t, registrationFor([anchor]));
  faults.set(anchor, "http-502");
  const declared = await indexRegistration(registrationFor([anchor], { [anchor]: OTHER_BYTES_HASH }), prior, offline);
  assert.deepEqual(declared.listings, [], "a declaration of other bytes for the anchor");
  recordListingRejection(anchor, seller, "OWNER_CLAIM_BINDING", { listingId: "dropped-when-declared-replaced", listingVersion: 1 }, true);
  assert.deepEqual((await indexRegistration(registrationFor([anchor]), prior, offline)).listings, [], "a public notice held for the anchor");
});

test("a kept Listing is superseded by a higher version read from another anchor", async (t) => {
  const first = await anchoredListing("kept-then-superseded", 7100, 1);
  const prior = await indexedWhileReadable(t, registrationFor([first.anchor]));
  const second = await anchoredListing("kept-then-superseded", 7120, 2);
  faults.set(first.anchor, "http-502");
  const record = await indexRegistration(registrationFor([first.anchor, second.anchor]), prior, offline);
  assert.deepEqual(record.listings.map(({ version, status }) => ({ version, status })).sort((a, b) => a.version - b.version),
    [{ version: 1, status: "superseded" }, { version: 2, status: "active" }]);
});

test("identical bytes read at a second anchor are not listed twice with a kept copy", async (t) => {
  const first = await anchoredListing("kept-with-twin-anchor", 7140);
  const prior = await indexedWhileReadable(t, registrationFor([first.anchor]));
  const twin = `stor-${"b".repeat(40)}`;
  maps.set(twin, first.listing);
  faults.set(first.anchor, "http-502");
  const record = await indexRegistration(registrationFor([first.anchor, twin]), prior, offline);
  assert.deepEqual(record.listings.map((listing) => listing.anchor.locator), [twin]);
});

test("reindexAll publishes the kept Listing after a storage outage", async (t) => {
  const { anchor } = await anchoredListing("published-through-outage", 7160);
  saveRegistrations([registrationFor([anchor])]);
  faults.clear();
  serveStorage(t);
  const reindex = () => reindexAll({
    log: () => {}, resolveIdentities: offline, crawlWellKnown: async () => ({ agents: [], errors: [] }),
  });
  const publishedTotal = async () => (await (await listings(new NextRequest("https://directory.example/api/dacs/listings"))).json()).total;
  await reindex();
  assert.equal(await publishedTotal(), 1, "the Listing is published while its anchor is readable");
  faults.set(anchor, "http-502");
  await reindex();
  assert.deepEqual(loadCatalog().sellers.find((record) => record.primaryClaim === seller)?.listings.map((listing) => listing.listingId),
    ["published-through-outage"]);
  assert.equal(await publishedTotal(), 1, "the outage does not empty the published catalog");
});

test("a same-chain tip reset replayed while the anchor read fails does not keep the prior Listing", async (t) => {
  const { anchor } = await anchoredListing("dropped-in-reset-replay", 7170);
  saveRegistrations([registrationFor([anchor])]);
  faults.clear();
  serveStorage(t);
  const reindex = () => reindexAll({
    log: () => {}, resolveIdentities: offline, crawlWellKnown: async () => ({ agents: [], errors: [] }),
  });
  const publishedIds = () => loadCatalog().sellers.find((record) => record.primaryClaim === seller)?.listings.map((listing) => listing.listingId);
  await reindex();
  assert.deepEqual(publishedIds(), ["dropped-in-reset-replay"]);
  // The node's tip falls far behind the saved cursor, so the next pass clears chain evidence and replays from genesis.
  nodeTransactions = [{ id: 5 }];
  saveScanState({ ...loadScanState(), lastSeenTxId: 5000, lastChainTip: undefined });
  faults.set(anchor, "http-502");
  await reindex();
  assert.deepEqual(publishedIds() ?? [], [], "a Listing the reset chain view no longer stands behind is not kept");
});
