import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";

// DACS-1 §6.3.6 read endpoints through the real reindex path over a stubbed node: they serve
// anonymous callers, and the BundleBinding catalog serves every BB-4-valid record (§6.3.6 L773).
// DACS-1 §6.3.5: a well-known card without a `dacs` block publishes no listings via well-known.
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-catalog-routes-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
process.env.DACS_SCAN_FINALITY_DEPTH = "0";

// The well-known crawl uses node:https directly; answer it from a table keyed by path.
const httpsAnswers = new Map<string, { status: number; body: string }>();
const httpsRequested: string[] = [];
const realRequest = https.request;
https.request = ((url: URL, _options: unknown, onResponse: (res: EventEmitter & { statusCode: number; headers: Record<string, string> }) => void) => {
  httpsRequested.push(String(url));
  const answer = httpsAnswers.get(new URL(String(url)).pathname) ?? { status: 404, body: "" };
  const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error?: Error) => void };
  request.destroy = (error) => { if (error) request.emit("error", error); };
  request.end = () => queueMicrotask(() => {
    const response = Object.assign(new EventEmitter(), { statusCode: answer.status, headers: { "content-type": "application/json" } });
    onResponse(response);
    response.emit("data", Buffer.from(answer.body));
    response.emit("end");
  });
  return request;
}) as unknown as typeof https.request;
syncBuiltinESMExports();
test.after(() => {
  https.request = realRequest;
  syncBuiltinESMExports();
  rmSync(dataDirectory, { recursive: true, force: true });
});

const store = await import("../src/catalog/store.js");
const { reindexAll } = await import("../src/catalog/reindexCore.js");
const { logicalBundleAddress, MAX_BUNDLE_BINDINGS_PER_JOB_ROLE, bundleBindingOverflowKey } = await import("../src/catalog/bundleBinding.js");
const { crawlDomain } = await import("../src/catalog/wellknown.js");
const listingsRoute = await import("../app/api/dacs/listings/route.js");
const listingRoute = await import("../app/api/dacs/listings/[listingId]/[version]/route.js");
const sellerRoute = await import("../app/api/dacs/sellers/[primaryClaimRef]/route.js");
const bundlesRoute = await import("../app/api/dacs/bundles/[jobId]/route.js");

type Obj = Record<string, unknown>;
const seeds = [41, 42].map((byte) => Uint8Array.from(Buffer.alloc(32, byte)));
const dids = seeds.map((seed) => `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`);
const [BUYER, SELLER] = [0, 1];
const ownerOf = (did: string) => `0x${did.slice(-64)}`;
const locator = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;
const sign = async (message: string, signer: number) =>
  Buffer.from(await ed25519Sign(Buffer.from(message), privateKeyFromSeed(seeds[signer]))).toString("base64url");

const listingScope = {
  listingId: "svc", listingVersion: 1, agentId: dids[SELLER], serviceId: "svc", name: "Route service", description: "Route test service",
  claimRequirements: [], supportedNegotiation: ["negotiate-fixed-price"], supportedPaymentRails: ["pay-dem"],
  supportedDelivery: ["deliver-attested-payload"],
};
const listing = { ...listingScope, signature: { algorithm: "ed25519", signer: dids[SELLER], value: await sign(`dacs-listing:v1:${contentHash(listingScope)}`, SELLER) } };

const JOB = "catalog-job";
async function binding(role: "buyer" | "seller", n: number, signer: number): Promise<Obj> {
  const scope = {
    bindingVersion: "1", jobId: JOB, role, logicalAddress: logicalBundleAddress(JOB, role),
    nativeAddress: locator(0x5000 + n), bundleContentHash: contentHash({ copy: role, n }), signer: dids[signer],
  };
  return { ...scope, signature: { algorithm: "ed25519", signer: dids[signer], value: await sign(`dacs-bundle-binding:v1:${contentHash(scope)}`, signer) } };
}
// More than the 32-per-signer work cap from the seller, and the buyer's own records for the same job.
const sellerBindings = await Promise.all(Array.from({ length: MAX_BUNDLE_BINDINGS_PER_JOB_ROLE + 8 }, (_, n) => binding("seller", n, SELLER)));
const buyerBindings = await Promise.all(Array.from({ length: 3 }, (_, n) => binding("buyer", 100 + n, BUYER)));

const storage = new Map<string, { data: Obj; owner: string }>([[locator(1), { data: listing, owner: ownerOf(dids[SELLER]) }]]);
[...sellerBindings, ...buyerBindings].forEach((value, n) =>
  storage.set(locator(0x100 + n), { data: value, owner: ownerOf(dids[value.signer === dids[BUYER] ? BUYER : SELLER]) }));
const written = [...storage.keys()];
const transactions = written.map((at, index) => ({ id: index + 1, status: "confirmed", type: "transfer",
  hash: (index + 1).toString(16).padStart(64, "0"), blockNumber: index + 1, to: "0x1", content: JSON.stringify({ memo: at }) })).reverse();
globalThis.fetch = async (input, init) => {
  const path = new URL(String(input)).pathname;
  if (path.startsWith("/storage-program/")) {
    const entry = storage.get(path.slice("/storage-program/".length));
    if (!entry) return Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
    return Response.json({ success: true, owner: entry.owner, programName: "opaque", data: entry.data });
  }
  const call = JSON.parse(String(init?.body)).params?.[0];
  return Response.json({ result: 200, response: call?.message === "getTransactions" && call.data?.start === "latest" ? transactions : [] });
};

// A domain whose A2A card has no `dacs` block: it publishes no listings via well-known.
const DOMAIN = "93.184.216.34";
httpsAnswers.set("/.well-known/agent.json", { status: 200, body: JSON.stringify({ name: "A2A-only agent", skills: [{ id: "chat" }] }) });
store.saveRegistrations([{ primaryClaim: dids[SELLER], displayName: "Route seller", listingAnchors: [locator(1)] }]);
store.saveDomains([DOMAIN]);
await reindexAll({ log: () => {}, resolveIdentities: async () => { throw new Error("identity unavailable"); } });

/** A request with no credentials of any kind. */
const anonymous = (path: string) => new NextRequest(`http://localhost${path}`);

test("§6.3.6 read endpoints answer an anonymous caller", async () => {
  const listings = await listingsRoute.GET(anonymous("/api/dacs/listings"));
  assert.equal(listings.status, 200);
  const page = await listings.json() as { listings: Obj[] };
  assert.deepEqual(page.listings.map((entry) => [entry.listingId, (entry.seller as Obj).primaryClaim]), [["svc", dids[SELLER]]]);

  const detail = await listingRoute.GET(anonymous("/api/dacs/listings/svc/1"), { params: Promise.resolve({ listingId: "svc", version: "1" }) });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json() as Obj).serviceId, "svc");

  const seller = await sellerRoute.GET(anonymous(`/api/dacs/sellers/${encodeURIComponent(dids[SELLER])}`),
    { params: Promise.resolve({ primaryClaimRef: dids[SELLER] }) });
  assert.equal(seller.status, 200);
  assert.equal(((await seller.json() as { listings: Obj[] }).listings).length, 1);

  const bundles = await bundlesRoute.GET(anonymous(`/api/dacs/bundles/${JOB}?limit=1`), { params: Promise.resolve({ jobId: JOB }) });
  assert.equal(bundles.status, 200);
  assert.equal((await bundles.json() as { bindings: Obj[] }).bindings.length, 1, "a valid stored binding is served");
});

test("§6.3.6: the catalog serves every BB-4-valid binding, from both parties, past the per-signer work cap", async () => {
  const served: Obj[] = [];
  const cursors: Array<string | undefined> = [];
  let cursor: string | undefined = "0";
  while (cursor !== undefined) {
    const response = await bundlesRoute.GET(anonymous(`/api/dacs/bundles/${JOB}?limit=20&cursor=${cursor}`), { params: Promise.resolve({ jobId: JOB }) });
    assert.equal(response.status, 200);
    const body = await response.json() as { bindings: Obj[]; total: number; cursor?: string };
    assert.equal(body.total, sellerBindings.length + buyerBindings.length);
    served.push(...body.bindings);
    cursor = body.cursor;
    cursors.push(cursor);
  }
  assert.deepEqual(cursors, ["20", "40", undefined]);
  const key = (value: Obj) => contentHash(value);
  assert.deepEqual(new Set(served.map(key)), new Set([...sellerBindings, ...buyerBindings].map(key)));
  assert.equal(served.filter((value) => value.signer === dids[SELLER]).length, MAX_BUNDLE_BINDINGS_PER_JOB_ROLE + 8);
  assert.equal(served.filter((value) => value.signer === dids[BUYER]).length, 3);
  // The ceiling still bounds the Directory's own BB-6 work: the seller's side is a sticky overflow.
  assert.ok(store.loadScanState().bundleBindingOverflow?.includes(bundleBindingOverflowKey(JOB, "seller", dids[SELLER])));
  assert.ok(!store.loadScanState().bundleBindingOverflow?.includes(bundleBindingOverflowKey(JOB, "buyer", dids[BUYER])));
  const invalid = await bundlesRoute.GET(anonymous(`/api/dacs/bundles/${JOB}?limit=500`), { params: Promise.resolve({ jobId: JOB }) });
  assert.equal(invalid.status, 400);
});

test("§6.3.5: a well-known card without a dacs block imports nothing, and catalog discovery still lists the seller", async () => {
  assert.ok(httpsRequested.some((url) => url.endsWith("/.well-known/agent.json")), "the reindex crawled the domain");
  const crawled = await crawlDomain(DOMAIN);
  assert.ok("error" in crawled, "no listings are published via well-known");
  assert.equal(httpsRequested.filter((url) => !url.endsWith("/.well-known/agent.json")).length, 0, "no index is fetched");
  const registration = store.loadRegistrations().find((entry) => entry.primaryClaim === dids[SELLER]);
  assert.deepEqual(registration?.listingAnchors, [locator(1)], "the card added no anchors");
  const page = await (await listingsRoute.GET(anonymous("/api/dacs/listings"))).json() as { listings: Obj[] };
  assert.equal(page.listings.length, 1, "the chain-registered listing is still discoverable");
});

test("well-known binding ingestion preserves all 40 records through reindex and catalog pagination", async () => {
  const jobId = "well-known-job";
  const bindings = await Promise.all(sellerBindings.map(async (value) => {
    const scope: Obj = { ...value, jobId, logicalAddress: logicalBundleAddress(jobId, "seller") };
    delete scope.signature;
    return { ...scope, signature: { algorithm: "ed25519", signer: dids[SELLER], value: await sign(`dacs-bundle-binding:v1:${contentHash(scope)}`, SELLER) } };
  }));
  const listings = JSON.stringify({ indexVersion: "1", generatedAt: 1, seller: dids[SELLER], listings: [] });
  const bindingIndex = JSON.stringify({ bindings });
  httpsAnswers.set("/listings.json", { status: 200, body: listings });
  httpsAnswers.set("/bindings.json", { status: 200, body: bindingIndex });
  httpsAnswers.set("/.well-known/agent.json", { status: 200, body: JSON.stringify({ dacs: { dacsVersion: "1",
    listings: { indexUrl: `https://${DOMAIN}/listings.json`, indexHash: `sha256-${sha256Hex(listings)}` },
    bundleBindings: { indexUrl: `https://${DOMAIN}/bindings.json`, indexHash: `sha256-${sha256Hex(bindingIndex)}` },
  } }) });
  const priorState = store.loadScanState();
  const priorOverflow = bundleBindingOverflowKey("prior-job", "buyer", dids[BUYER]);
  store.saveScanState({ ...priorState, schemaVersion: 10, bundleBindings: { ...priorState.bundleBindings, [jobId]: bindings.slice(0, 5) as never },
    bundleBindingOverflow: [...(priorState.bundleBindingOverflow ?? []), priorOverflow] });
  await reindexAll({ log: () => {}, resolveIdentities: async () => [] });
  assert.ok(store.loadScanState().bundleBindingOverflow?.includes(priorOverflow));
  assert.equal(store.loadScanState().bundleBindings?.[jobId]?.length, 40);
  assert.ok(store.loadScanState().bundleBindingOverflow?.includes(bundleBindingOverflowKey(jobId, "seller", dids[SELLER])));
  const response = await bundlesRoute.GET(anonymous(`/api/dacs/bundles/${jobId}?limit=100`), { params: Promise.resolve({ jobId }) });
  assert.equal(response.status, 200);
  const body = await response.json() as { bindings: Obj[]; total: number };
  assert.equal(body.total, 40);
  assert.deepEqual(new Set(body.bindings.map(contentHash)), new Set(bindings.map(contentHash)));
});
