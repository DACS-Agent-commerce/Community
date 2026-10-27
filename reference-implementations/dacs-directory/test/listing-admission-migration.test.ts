import assert from "node:assert/strict";
import { onPinnedChain } from "./fixtures/pinned-node.js";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed } from "@kynesyslabs/dacs/crypto";
import { vector, sign, seeds, dids, locator, type Obj } from "./fixtures/current-evidence.js";
import { signedRailSnapshot } from "./signed-rail-snapshot.js";

const directory = mkdtempSync(join(tmpdir(), "dacs-listing-admission-upgrade-"));
process.env.DACS_DIRECTORY_DATA = directory;
test.after(() => rmSync(directory, { recursive: true, force: true }));

const fixture = await vector("admission-upgrade", 900);
const { signature: _, ...original } = fixture.listing;
const seller = dids[1];
// LP-2 allows any key in seller.identity.claims, including this second key.
const identity = { ...((original.seller as Obj).identity as Obj), claims: [{ ref: seller }, { ref: dids[0] }] };
delete (identity as Obj).presentation;
const presentation = { kind: "per-claim", signatures: [{ ref: seller,
  signature: Buffer.from(ed25519Sign(Buffer.from(`dacs-bundle-presentation:v1:${contentHash(identity)}`), privateKeyFromSeed(seeds[1]))).toString("base64url") }] };
const goodScope = { ...original, listingId: "allowed-second-key", seller: { ...(original.seller as Obj), identity: { ...identity, presentation } },
  acceptedRails: [{ railId: "demos-native:DEM" }], pipeline: [
    { kind: "negotiate-fixed-price" }, { kind: "commit-agreement" },
    { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }, { kind: "deliver-attested-payload" },
  ] };
const good = { ...goodScope, signature: await sign(goodScope, "listing", 0) };
const badScope = { ...original, listingId: "missing-method", offering: { ...(original.offering as Obj), deliverable: { kind: "attested-payload", payloadFormat: "application/json" } } };
const bad = { ...badScope, signature: await sign(badScope, "listing", 1) };
const reg = { primaryClaim: seller, displayName: "Upgrade seller", listingAnchors: [locator(901), locator(902)], deals: [] };
const summary = (raw: Obj, at: string) => ({
  listingId: raw.listingId, version: 1, contentHash: contentHash(raw),
  anchor: { kind: "storage-program", locator: at }, seller: { primaryClaim: seller, displayName: reg.displayName },
  offering: { title: raw.listingId, category: "services.test", tags: [] }, pricing: {}, status: "active", catalogObservedAt: 1,
});
// An active version 2 of an offer that also has version 1, and a fixture listing that is no chain admission decision.
const nextVersion = { ...summary(good, locator(905)), version: 2 };
const fixtureListing = { ...summary(good, "fixture:desk"), listingId: "fixture-desk", anchor: { kind: "fixture", locator: "fixture:desk" } };
const withdrawnScope = { ...original, listingId: "withdrawn" };
const withdrawn = { ...withdrawnScope, signature: await sign(withdrawnScope, "listing", 1) };
const tombstone = { ...summary(withdrawn, locator(903)), status: "revoked", revocation: {
  sellerPrimaryClaim: seller, listingId: "withdrawn", listingVersion: 1, listingContentHash: contentHash(withdrawn),
  logicalAddress: `dacs1-revoked:${encodeURIComponent(seller)}:withdrawn:v1`,
  markerAnchor: { kind: "storage-program", locator: locator(904) }, markerContentHash: "a".repeat(64),
} };
// Rows from before any shape guarantee: no anchor at all, and an unusable version.
const anchorless = { contentHash: "c".repeat(64), status: "active" };
const unnumbered = { ...summary(good, locator(906)), listingId: "unnumbered", version: "one" };
// A deal whose cached verdict was reached with the old Listing reader, and the reputation counted from it.
const cachedDeal = { jobId: "job-cached", rail: "demos-native:DEM", buyerBundleRef: locator(907), sellerBundleRef: locator(908),
  owners: { buyer: dids[0], seller }, signatureVerified: true, refsVerified: true, reputationEligible: true,
  outcome: "completed", sellerOutcome: "completed", finalisedAt: 1, verifiedAt: 1 };
const seeded = new Database(join(directory, "directory.sqlite"));
seeded.exec("CREATE TABLE kv_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
const put = seeded.prepare("INSERT INTO kv_state VALUES (?, ?, 0)");
for (const [key, value] of Object.entries({
  "schema-version": 1, "sr2-anchor-schema-version": 2,
  "catalog": { catalogVersion: "1", generatedAt: 1, sellers: [{ ...reg, cci: [],
    listings: [summary(bad, locator(901)), summary(good, locator(902)), nextVersion, fixtureListing, tombstone, anchorless, unnumbered],
    deals: [cachedDeal], reputation: { completed: 1, totalAgreements: 1, completionRate: 1 }, registeredAt: 1, lastIndexedAt: 1 }] },
  "registrations": [reg], "scan-state": { lastSeenTxId: 20, listings: { [locator(902)]: `0x${seller.slice(-64)}` }, deals: {} },
})) put.run(key, JSON.stringify(value));
seeded.close();

const store = await import("../src/catalog/store.js");
const { indexRegistration } = await import("../src/catalog/indexer.js");
const { verifyListingResult } = await import("../src/catalog/listingVerification.js");
const { GET } = await import("../app/api/dacs/listings/route.js");
const restart = () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `const s=await import('./src/catalog/store.ts'); console.log(JSON.stringify(s.loadCatalog()))`],
  { encoding: "utf8", env: process.env, timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
};

const listedIds = (catalog: { sellers: Array<{ listings: Obj[] }> }) => catalog.sellers[0].listings.map((l) => l.listingId);

// First: the next test saves a reindexed catalog over the seeded one.
test("the reset withholds cached deal verdicts and the reputation counted from them until a reindex", async () => {
  const { GET: getSeller } = await import("../app/api/dacs/sellers/[primaryClaimRef]/route.js");
  // The route receives the already-decoded path segment.
  const publicSeller = async () => (await getSeller(new NextRequest("https://directory.example/api/dacs/sellers/x"),
    { params: Promise.resolve({ primaryClaimRef: seller }) })).json();
  for (const view of [await publicSeller(), restart().sellers[0]]) {
    assert.deepEqual((view.deals as Obj[]).map((deal) => [deal.jobId, deal.refsVerified, deal.reputationEligible]), [["job-cached", false, false]]);
    assert.equal(view.reputation.completed, 0);
  }
});

test("old active admission decisions stay withheld through restart, then valid artifacts return", async () => {
  assert.deepEqual(await verifyListingResult(bad), { ok: false, code: "VERIFICATION_METHOD_INVALID" });
  assert.equal((await verifyListingResult(good)).ok, true, "a second authorized seller key is allowed");
  const listed = async () => (await (await GET(new NextRequest("https://directory.example/api/dacs/listings"))).json()).listings;
  assert.deepEqual((await listed()).map((l: Obj) => l.listingId), ["fixture-desk", "withdrawn"]);
  assert.deepEqual(listedIds(restart()), ["fixture-desk", "withdrawn"]);
  assert.deepEqual(store.loadRegistrations(), [reg]);
  assert.equal(store.loadScanState().lastSeenTxId, 20);
  assert.equal(store.loadScanState().listings[locator(902)], `0x${seller.slice(-64)}`);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const at = String(input).split("/").pop();
    const data = at === locator(901) ? bad : at === locator(902) ? good : null;
    return data ? Response.json({ success: true, owner: `0x${seller.slice(-64)}`, data }) : new Response(null, { status: 503 });
  };
  try {
    const record = await indexRegistration(reg, store.loadCatalog().sellers[0], async () => { throw new Error("offline"); });
    assert.deepEqual(record.listings.map((l) => l.listingId), ["allowed-second-key"]);
    assert.equal(store.indexerDiagnostics().listingRejectionDiagnostics.byCode.VERIFICATION_METHOD_INVALID, 1);
    record.listings.push(...store.loadCatalog().sellers[0].listings.filter((l) => l.status === "revoked"));
    store.saveCatalog({ catalogVersion: "1", generatedAt: Date.now(), sellers: [record] });
    assert.deepEqual(restart().sellers[0].listings.map((l: Obj) => l.listingId), ["allowed-second-key", "withdrawn"]);
    assert.deepEqual((await listed()).map((l: Obj) => l.listingId), ["allowed-second-key", "withdrawn"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("the reset keeps the highest withheld version so the publisher never renumbers it", () => {
  assert.equal(store.listingVersionFloor(seller, "allowed-second-key"), 2);
  assert.equal(store.listingVersionFloor(seller, "missing-method"), 1);
  assert.equal(store.listingVersionFloor(seller, "withdrawn"), 1, "a tombstone that a later reindex may drop still holds its version");
  assert.equal(store.listingVersionFloor(seller, "never-published"), 0);
  assert.equal(store.listingVersionFloor(seller, "unnumbered"), 0, "an unusable version records no floor");
});

test("the publisher numbers a new version after the withheld one", async () => {
  const { createBuildListingPost } = await import("../src/catalog/buildListing.js");
  // The shipped rail table is unsigned and the route refuses it (LP-6), so number against a signed snapshot.
  const POST = createBuildListingPost(signedRailSnapshot);
  const { NextRequest: Request } = await import("next/server");
  const call = (body: Obj) => POST(new Request("https://directory.example/api/dacs/build-listing", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const base = { claim: seller, serviceId: "allowed-second-key", name: "Upgrade", description: "after the reset",
    rails: ["demos-native:DEM"], delivery: ["deliver-storage-program"], pricing: { kind: "fixed", amount: "1", currency: "DEM" } };
  const { identityMessage, identityPresentedAt, listingVersion } = await (await call(base)).json();
  const identitySignature = Buffer.from(ed25519Sign(Buffer.from(identityMessage, "utf8"), privateKeyFromSeed(seeds[1]))).toString("hex");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const call = JSON.parse(String(init?.body)).params?.[0];
    return Response.json({ result: 200, response: call?.message === "searchStoragePrograms" ? [] : 0 });
  };
  try {
    const built = await (await call({ ...base, listingVersion, identityPresentedAt, identitySignature })).json();
    assert.equal(built.listing.listingVersion, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the reset runs once: a listing saved after it survives the next start", () => {
  const catalog = store.loadCatalog();
  const saved = { ...catalog.sellers[0].listings[0], listingId: "saved-after-reset", status: "active" as const };
  store.saveCatalog({ ...catalog, sellers: [{ ...catalog.sellers[0], listings: [...catalog.sellers[0].listings, saved] }] });
  assert.deepEqual(listedIds(restart()), ["allowed-second-key", "withdrawn", "saved-after-reset"]);
});

test("a reindex returns only the old offers that pass the current reader", async () => {
  const { reindexAll } = await import("../src/catalog/reindexCore.js");
  const owner = `0x${seller.slice(-64)}`;
  const stored = new Map<string, Obj>([[locator(901), bad], [locator(902), good]]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (init?.body) return Response.json({ result: 200, response: [] });
    const data = stored.get(String(input).split("/").pop() ?? "");
    return data ? Response.json({ success: true, owner, data }) : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
  };
  try {
    await reindexAll({ nodeDeployment: onPinnedChain, log: () => {}, resolveIdentities: async () => { throw new Error("offline"); },
      crawlWellKnown: async () => ({ agents: [], errors: [] }) });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const returned = (catalog: ReturnType<typeof store.loadCatalog>) =>
    catalog.sellers[0].listings.filter((l) => l.status === "active" && l.anchor.kind !== "fixture").map((l) => l.listingId);
  assert.deepEqual(returned(store.loadCatalog()), ["allowed-second-key"]);
  assert.deepEqual(returned(restart()), ["allowed-second-key"]);
});
