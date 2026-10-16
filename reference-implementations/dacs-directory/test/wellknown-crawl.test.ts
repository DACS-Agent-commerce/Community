import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";

// §6.3.5 end to end: the Directory's own well-known generator, its crawler and
// the declared-hash check in the indexer, over a stubbed node and web server.
process.env.DACS_DIRECTORY_DATA = mkdtempSync(join(tmpdir(), "dacs-directory-wellknown-"));
process.env.DEMOS_RPC = "https://node.test";
const store = await import("../src/catalog/store.js");
const { indexRegistration } = await import("../src/catalog/indexer.js");
const { findValidListingRevocation, verifyListing } = await import("../src/catalog/listingVerification.js");
const { crawlDomain, projectActiveListingIndexEntries } = await import("../src/catalog/wellknown.js");
const wellknownFiles = await import("../app/api/dacs/wellknown-files/route.js");

const seed = Uint8Array.from(Buffer.alloc(32, 0x31));
const privateKey = privateKeyFromSeed(seed);
const claim = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const owner = `0x${claim.slice(-64)}`;
// CF-3 advisory parameters: not part of identity, but RB-2 binds their exact bytes.
const presentedBy = `${claim}?channel=directory`;
const sign = (message: string) => Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKey)).toString("base64url");
const locator = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;

function listingFor(listingId: string): Record<string, unknown> {
  const identity: Record<string, unknown> = {
    bundleVersion: "1", presentedBy, presentedAt: 1, claims: [{ ref: presentedBy, kind: "signing-key" }],
  };
  identity.presentation = { kind: "per-claim", signatures: [{ ref: presentedBy, signature: sign(`dacs-bundle-presentation:v1:${contentHash(identity)}`) }] };
  const scope: Record<string, unknown> = {
    dacsVersion: "1", listingVersion: 1, listingId,
    seller: { displayName: "Well-known seller", identity },
    offering: { title: listingId, description: "served from a domain", category: "conformance.signature", tags: [], deliverable: { kind: "storage-program" } },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }, { kind: "deliver-storage-program" }],
    pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } },
    acceptedRails: [{ railId: "demos-native:DEM" }],
    terms: {}, validity: { notBefore: 1 },
  };
  return { ...scope, signature: { algorithm: "ed25519", signer: presentedBy, value: sign(`dacs-listing:v1:${contentHash(scope)}`) } };
}

const active = listingFor("wk-active");
const revoked = listingFor("wk-revoked");
const storage: Record<string, Record<string, unknown>> = { [locator(1)]: active, [locator(2)]: revoked };
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  const at = url.pathname.startsWith("/storage-program/") ? url.pathname.slice("/storage-program/".length) : null;
  if (!at) return new Response(null, { status: 503 }); // identity lookups are best effort
  if (!storage[at]) return new Response(null, { status: 404 });
  return Response.json({ success: true, owner, programName: "opaque", data: storage[at] });
};
const offline = async (): Promise<never> => { throw new Error("identity unavailable"); };
const registration = { primaryClaim: claim, displayName: "Well-known seller", listingAnchors: [locator(1), locator(2)] };

const verifiedRevoked = (await verifyListing(revoked))!;
const markerScope = { listingId: "wk-revoked", listingVersion: 1, listingContentHash: verifiedRevoked.contentHash, revokedAt: 1 };
const marker = { ...markerScope, signature: { algorithm: "ed25519", signer: presentedBy, value: sign(`dacs-revocation:v1:${contentHash(markerScope)}`) } };
const binding = (await findValidListingRevocation([locator(60)], verifiedRevoked, 1, async () => marker))!;

/** Publish the catalog, then generate the seller's hosted files exactly as the Directory does. */
async function generatedFiles(): Promise<Record<string, string>> {
  const record = await indexRegistration(registration, undefined, offline);
  record.listings = record.listings.map((listing) => listing.listingId === "wk-revoked"
    ? { ...listing, status: "revoked", revocation: binding } : listing);
  store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [record] });
  const response = await wellknownFiles.GET(new NextRequest(
    `https://directory.test/api/dacs/wellknown-files?claim=${encodeURIComponent(claim)}&domain=1.1.1.1`,
  ));
  assert.equal(response.status, 200);
  return (await response.json()).files;
}

// A public IP literal needs no DNS lookup; the stub serves every request.
const domain = "1.1.1.1";
const served = (files: Record<string, string>) => async (url: string) => {
  const path = new URL(url).pathname;
  return path in files ? { status: 200, body: Buffer.from(files[path]!) } : { status: 404, body: Buffer.alloc(0) };
};
const rehashed = (files: Record<string, string>, listings: string) => {
  const card = JSON.parse(files["/.well-known/agent.json"]!);
  card.dacs.listings.indexHash = `sha256-${sha256Hex(listings)}`;
  return { "/.well-known/agent.json": JSON.stringify(card), "/.well-known/dacs/listings.json": listings };
};

test("the crawler accepts the well-known files the Directory generates for a parameter-bearing presentedBy", async () => {
  const files = await generatedFiles();
  const index = JSON.parse(files["/.well-known/dacs/listings.json"]!);
  assert.equal(index.listings.find((entry: { listingId: string }) => entry.listingId === "wk-revoked").revocation.sellerPrimaryClaim, presentedBy);
  const crawled = await crawlDomain(domain, served(files));
  assert.ok(!("error" in crawled), JSON.stringify(crawled));
  assert.equal(crawled.seller, claim);
  assert.deepEqual(crawled.listingAnchors, [locator(1)], "only the active listing is indexed");
  assert.deepEqual(crawled.contentHashes, { [locator(1)]: (await verifyListing(active))!.contentHash });
});

test("a revocation binding is accepted only for the index seller and the address its own claim derives", () => {
  const entry = {
    listingId: "wk-revoked", version: 1, contentHash: verifiedRevoked.contentHash,
    anchor: { kind: "storage-program", locator: locator(2) },
    summary: { title: "wk-revoked", category: "conformance.signature", tags: [] }, status: "revoked", revocation: binding,
  };
  assert.deepEqual(projectActiveListingIndexEntries([entry], claim), { ok: true, listingAnchors: [], contentHashes: {} });
  const other = `did:demos:agent:${"b".repeat(64)}`;
  const canonicalAddress = `dacs1-revoked:${claim.replaceAll(":", "%3A")}:wk-revoked:v1`;
  for (const [name, revocation, seller] of [
    ["another seller's index", binding, other],
    ["another agent's claim", { ...binding, sellerPrimaryClaim: `${other}?channel=directory` }, claim],
    ["address of the canonical claim, not the presented one", { ...binding, logicalAddress: canonicalAddress }, claim],
    ["another version's address", { ...binding, logicalAddress: binding.logicalAddress.replace(/:v1$/, ":v2") }, claim],
  ] as const) {
    assert.equal(projectActiveListingIndexEntries([{ ...entry, revocation }], seller).ok, false, name);
  }
});

test("the crawler refuses well-known files whose binding, version or seller does not hold", async () => {
  const files = await generatedFiles();
  const listings = files["/.well-known/dacs/listings.json"]!;
  const index = JSON.parse(listings);
  const card = JSON.parse(files["/.well-known/agent.json"]!);
  const withCard = (change: (value: typeof card) => void) => {
    const copy = structuredClone(card);
    change(copy);
    return { ...files, "/.well-known/agent.json": JSON.stringify(copy) };
  };
  const cases: Array<[string, Record<string, string>, RegExp]> = [
    ["no agent card", { "/.well-known/dacs/listings.json": listings }, /no \.well-known\/agent\.json/],
    ["unsupported dacsVersion", withCard((value) => { value.dacs.dacsVersion = "2"; }), /no supported dacs\.listings/],
    ["no index URL", withCard((value) => { delete value.dacs.listings.indexUrl; }), /no supported dacs\.listings/],
    ["index unreachable", { "/.well-known/agent.json": files["/.well-known/agent.json"]! }, /listings index unreachable/],
    ["index bytes changed", { ...files, "/.well-known/dacs/listings.json": `${listings}\n` }, /indexHash mismatch/],
    ["no declared index hash", withCard((value) => { delete value.dacs.listings.indexHash; }), /indexHash mismatch/],
    ["another index's hash", withCard((value) => { value.dacs.listings.indexHash = `sha256-${"0".repeat(64)}`; }), /indexHash mismatch/],
    ["index version 2", rehashed(files, JSON.stringify({ ...index, indexVersion: "2" })), /invalid version or generatedAt/],
    ["generatedAt 0", rehashed(files, JSON.stringify({ ...index, generatedAt: 0 })), /invalid version or generatedAt/],
    ["fractional generatedAt", rehashed(files, JSON.stringify({ ...index, generatedAt: 1.5 })), /invalid version or generatedAt/],
    ["non-canonical seller", rehashed(files, JSON.stringify({ ...index, seller: claim.toUpperCase() })), /no canonical Demos seller/],
    ["another seller", rehashed(files, JSON.stringify({ ...index, seller: `did:demos:agent:${"b".repeat(64)}` })), /no matching revocation binding/],
    ["a null index", rehashed(files, "null"), /invalid version or generatedAt/],
    ["an array index", rehashed(files, JSON.stringify([index])), /invalid version or generatedAt/],
    ["a non-string seller", rehashed(files, JSON.stringify({ ...index, seller: 7 })), /no canonical Demos seller/],
    ["no listings array", rehashed(files, JSON.stringify({ ...index, listings: null })), /at most 200 listings/],
    ["an entry without its summary", rehashed(files, JSON.stringify({
      ...index,
      listings: index.listings.map(({ summary: _summary, ...entry }: Record<string, unknown>) => entry),
    })), /invalid listing entry/],
  ];
  for (const [name, hosted, error] of cases) {
    const crawled = await crawlDomain(domain, served(hosted));
    assert.ok("error" in crawled, name);
    assert.match(crawled.error, error, name);
  }
  // The declared hash is case-insensitive hex with an optional `sha256-` prefix.
  const upper = withCard((value) => { value.dacs.listings.indexHash = sha256Hex(listings).toUpperCase(); });
  assert.ok(!("error" in await crawlDomain(domain, served(upper))));
  // A server that never answers is an unreachable card, not a crash.
  const down = await crawlDomain(domain, async () => { throw new Error("connection refused"); });
  assert.deepEqual(down, { domain, error: "no .well-known/agent.json" });
});

test("a bundle-binding index is bound by its own declared hash", async () => {
  const files = await generatedFiles();
  const bindings = JSON.stringify({ bindings: [] });
  const card = JSON.parse(files["/.well-known/agent.json"]!);
  const hosted = (indexHash: string) => {
    card.dacs.bundleBindings = { indexUrl: `https://${domain}/.well-known/dacs/bindings.json`, indexHash };
    return { ...files, "/.well-known/agent.json": JSON.stringify(card), "/.well-known/dacs/bindings.json": bindings };
  };
  const accepted = await crawlDomain(domain, served(hosted(`sha256-${sha256Hex(bindings)}`)));
  assert.ok(!("error" in accepted), JSON.stringify(accepted));
  assert.deepEqual(accepted.bundleBindings, []);
  for (const indexHash of ["", `sha256-${"0".repeat(64)}`]) {
    const refused = await crawlDomain(domain, served(hosted(indexHash)));
    assert.ok("error" in refused);
    assert.match(refused.error, /bundle-binding indexHash mismatch/);
  }
});

test("a listing is indexed only when it matches the content hash its domain declares", async () => {
  const activeHash = (await verifyListing(active))!.contentHash;
  const indexed = async (declared: string) => (await indexRegistration(
    { ...registration, listingAnchors: [locator(1)], listingContentHashes: { [locator(1)]: declared } },
    undefined,
    offline,
  )).listings.map((listing) => listing.listingId);
  assert.deepEqual(await indexed(`sha256-${activeHash.toUpperCase()}`), ["wk-active"]);
  assert.deepEqual(await indexed(activeHash), ["wk-active"]);
  assert.deepEqual(await indexed("0".repeat(64)), [], "a declared hash that does not match withholds the listing");
});
