import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { contentHash, stripSignature } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { legacyListingHash } from "../src/catalog/legacyListingHash.js";

process.env.DACS_DIRECTORY_DATA = mkdtempSync(join(tmpdir(), "dacs-directory-wellknown-route-"));
process.env.DEMOS_RPC = "https://node.test";
const store = await import("../src/catalog/store.js");
const { GET } = await import("../app/api/dacs/wellknown-files/route.js");

const seed = Buffer.alloc(32, 73);
const hex = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex");
const claim = `did:demos:agent:${hex}`;
const locator = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;
const listingRecord = (n: number) => ({
  listingId: `svc-${n}`, version: 1, status: "active", anchor: { kind: "storage-program", locator: locator(n) },
  offering: { title: `service ${n}`, category: "services.test", tags: [], description: "test service" }, pricing: {},
});

test("a stored listing with no canonical form is left out of the hosted index instead of failing the route", async () => {
  store.saveCatalog({
    catalogVersion: "1", generatedAt: 1,
    sellers: [{ primaryClaim: claim, displayName: "seller", listings: [listingRecord(1), listingRecord(2)] }] as never,
  });
  const stored: Record<string, string> = {
    // 1e400 parses to Infinity, which the SDK refuses to canonicalize.
    [locator(1)]: '{"listingId":"svc-1","future":1e400}',
    [locator(2)]: '{"listingId":"svc-2"}',
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const data = stored[new URL(String(input)).pathname.split("/").pop() ?? ""];
    return data === undefined ? new Response(null, { status: 503 })
      : new Response(`{"success":true,"owner":"0x${hex}","programName":"opaque","data":${data}}`, { headers: { "content-type": "application/json" } });
  };
  try {
    const response = await GET(new NextRequest(`http://localhost/api/dacs/wellknown-files?claim=${claim}`));
    assert.equal(response.status, 200);
    const files = (await response.json()).files as Record<string, string>;
    const listed = JSON.parse(files["/.well-known/dacs/listings.json"]).listings;
    // The route publishes only Listings that verify: the unhashable one is left out without failing
    // the route, and so is the stand-in that is not a signed Listing.
    assert.deepEqual(listed, []);
  } finally { globalThis.fetch = original; }
});

test("hosted index hashes a historical Listing with its frozen profile and a current Listing with the current one", async () => {
  const sign = (message: string) => Buffer.from(ed25519Sign(Buffer.from(message), privateKeyFromSeed(seed))).toString("base64url");
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/reviewbot-listing-anchor.json", import.meta.url), "utf8"));
  const { signature: _signature, ...draft } = fixture.data;
  // Both profiles carry authentic signatures over the decomposed member name.
  const historicalScope = { ...draft, agentId: claim, serviceId: "svc-3", ["e\u0301"]: "member" };
  const historicalHash = legacyListingHash(historicalScope);
  const historical = { ...historicalScope, signature: sign(`dacs-listing:v1:${historicalHash}`) };
  const identityScope = { bundleVersion: "1", presentedBy: claim, presentedAt: 1, claims: [{ ref: claim }] };
  const currentScope = {
    dacsVersion: "1", listingId: "svc-4", listingVersion: 1, requiredCapabilities: ["SR-2"], ["e\u0301"]: "member",
    seller: { displayName: "seller", identity: { ...identityScope, presentation: { kind: "per-claim", signatures: [{ ref: claim,
      signature: sign(`dacs-bundle-presentation:v1:${contentHash(identityScope)}`) }] } } },
    offering: { title: "service 4", description: "test service", category: "services.test", tags: [],
      deliverable: { kind: "storage-program", accessModel: "public" } },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "deliver-storage-program" }],
    pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } }, terms: {}, validity: { notBefore: 1 },
  };
  const currentHash = contentHash(currentScope);
  const current = { ...currentScope, signature: { algorithm: "ed25519", signer: claim,
    value: sign(`dacs-listing:v1:${currentHash}`) } };
  store.saveCatalog({
    catalogVersion: "1", generatedAt: 1,
    sellers: [{ primaryClaim: claim, displayName: "seller", listings: [
      { ...listingRecord(3), contentHash: historicalHash }, { ...listingRecord(4), contentHash: currentHash },
    ] }] as never,
  });
  const stored: Record<string, unknown> = { [locator(3)]: historical, [locator(4)]: current };
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const data = stored[new URL(String(input)).pathname.split("/").pop() ?? ""];
    return data === undefined ? new Response(null, { status: 503 })
      : Response.json({ success: true, owner: `0x${hex}`, programName: "opaque", data });
  };
  try {
    const response = await GET(new NextRequest(`http://localhost/api/dacs/wellknown-files?claim=${claim}`));
    const files = (await response.json()).files as Record<string, string>;
    const hashes = Object.fromEntries(JSON.parse(files["/.well-known/dacs/listings.json"]).listings
      .map((entry: { listingId: string; contentHash: string }) => [entry.listingId, entry.contentHash]));
    assert.equal(hashes["svc-3"], legacyListingHash(stripSignature(historical)));
    assert.notEqual(hashes["svc-3"], contentHash(stripSignature(historical)));
    assert.equal(hashes["svc-4"], contentHash(stripSignature(current)));
  } finally { globalThis.fetch = original; }
});
