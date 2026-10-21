import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { contentHash, listingAddress } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { createCatalogBindingIndex, queryListingCatalog } from "../vendor/dacs-sdk/dist/discovery/catalog.js";

// §6.3.6 interop: every summary the Directory serves goes through the pinned
// SDK's catalog client, for a plain and a CF-3 parameter-bearing presentedBy.
process.env.DACS_DIRECTORY_DATA = mkdtempSync(join(tmpdir(), "dacs-directory-catalog-sdk-"));
process.env.DEMOS_RPC = "https://node.test";
const store = await import("../src/catalog/store.js");
const { indexRegistration } = await import("../src/catalog/indexer.js");
const { findValidListingRevocation, verifyListing } = await import("../src/catalog/listingVerification.js");
const listingsRoute = await import("../app/api/dacs/listings/route.js");
const listingRoute = await import("../app/api/dacs/listings/[listingId]/[version]/route.js");
const inspectRoute = await import("../app/api/dacs/inspect-service/[listingId]/[version]/route.js");
const sellersRoute = await import("../app/api/dacs/sellers/[primaryClaimRef]/route.js");

const seed = Uint8Array.from(Buffer.alloc(32, 0x52));
const privateKey = privateKeyFromSeed(seed);
const claim = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const owner = `0x${claim.slice(-64)}`;
const sign = (message: string) => Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKey)).toString("base64url");
const locator = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;
const offline = async (): Promise<never> => { throw new Error("identity unavailable"); };

function listingFor(listingId: string, presentedBy: string): Record<string, unknown> {
  const identity: Record<string, unknown> = {
    bundleVersion: "1", presentedBy, presentedAt: 1, claims: [{ ref: presentedBy, kind: "signing-key" }],
  };
  identity.presentation = { kind: "per-claim", signatures: [{ ref: presentedBy, signature: sign(`dacs-bundle-presentation:v1:${contentHash(identity)}`) }] };
  const scope: Record<string, unknown> = {
    dacsVersion: "1", listingVersion: 1, listingId,
    seller: { displayName: "Interop seller", identity },
    offering: { title: listingId, description: "catalog interop", category: "conformance.signature", tags: [], deliverable: { kind: "storage-program" } },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }, { kind: "deliver-storage-program" }],
    pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } },
    acceptedRails: [{ railId: "demos-native:DEM" }],
    terms: {}, validity: { notBefore: 1 },
  };
  return { ...scope, signature: { algorithm: "ed25519", signer: presentedBy, value: sign(`dacs-listing:v1:${contentHash(scope)}`) } };
}

/** Index one active and one revoked listing presented as `presentedBy`, then publish the catalog. */
async function publishCatalog(presentedBy: string): Promise<void> {
  const active = listingFor("interop-active", presentedBy);
  const revoked = listingFor("interop-revoked", presentedBy);
  const storage: Record<string, Record<string, unknown>> = { [locator(1)]: active, [locator(2)]: revoked };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const at = url.pathname.startsWith("/storage-program/") ? url.pathname.slice("/storage-program/".length) : null;
    if (!at) return new Response(null, { status: 503 });
    if (!storage[at]) return new Response(null, { status: 404 });
    return Response.json({ success: true, owner, programName: "opaque", data: storage[at] });
  };
  const verifiedRevoked = (await verifyListing(revoked))!;
  const markerScope = { listingId: "interop-revoked", listingVersion: 1, listingContentHash: verifiedRevoked.contentHash, revokedAt: 1 };
  const marker = { ...markerScope, signature: { algorithm: "ed25519", signer: presentedBy, value: sign(`dacs-revocation:v1:${contentHash(markerScope)}`) } };
  const binding = (await findValidListingRevocation([locator(60)], verifiedRevoked, 1, async () => marker))!;
  const record = await indexRegistration(
    { primaryClaim: claim, displayName: "Interop seller", listingAnchors: [locator(1), locator(2)] },
    undefined,
    offline,
  );
  assert.equal(record.listings.length, 2);
  record.listings = record.listings.map((listing) => listing.listingId === "interop-revoked"
    ? { ...listing, status: "revoked", revocation: binding } : listing);
  store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [record] });
}

const servedPage = (page: unknown) => (async () => Response.json(page)) as typeof fetch;

for (const [name, presentedBy] of [
  ["a plain presentedBy", claim],
  ["a parameter-bearing presentedBy", `${claim}?channel=directory`],
] as const) {
  test(`the pinned SDK catalog client accepts every summary the Directory serves for ${name}`, async () => {
    await publishCatalog(presentedBy);

    const view = await (await sellersRoute.GET(
      new NextRequest(`https://directory.test/api/dacs/sellers/${encodeURIComponent(claim)}`),
      { params: Promise.resolve({ primaryClaimRef: encodeURIComponent(claim) }) },
    )).json();
    assert.deepEqual(view.listings.map((l: { status: string }) => l.status).sort(), ["active", "revoked"]);
    for (const summary of view.listings) {
      assert.equal(summary.seller.primaryClaim, presentedBy, "summaries carry the exact presentedBy bytes");
    }
    const sellerPage = await queryListingCatalog({
      catalogUrl: "https://directory.test/api/dacs/listings",
      fetchImpl: servedPage({ listings: view.listings }),
    });
    assert.equal(sellerPage.status, "ok", JSON.stringify(sellerPage));
    assert.equal(sellerPage.status === "ok" && sellerPage.page.listings.length, 2);

    const listings = await (await listingsRoute.GET(new NextRequest("https://directory.test/api/dacs/listings"))).json();
    const catalogPage = await queryListingCatalog({
      catalogUrl: "https://directory.test/api/dacs/listings",
      fetchImpl: servedPage(listings),
    });
    assert.equal(catalogPage.status, "ok", JSON.stringify(catalogPage));
    const resolver = createCatalogBindingIndex({
      catalogUrl: "https://directory.test/api/dacs/listings",
      fetchImpl: servedPage(listings),
    });
    const resolution = await resolver.resolve(listingAddress(presentedBy, "interop-active", 1), owner.slice(2));
    assert.equal(resolution.status, "present", JSON.stringify(resolution));
    assert.equal(resolution.status === "present" && resolution.binding.nativeAddress, locator(1));

    // The Directory's own lookups and links address the seller by CF-3 identity.
    const filtered = await (await listingsRoute.GET(new NextRequest(
      `https://directory.test/api/dacs/listings?primaryClaim=${encodeURIComponent(claim)}`,
    ))).json();
    // Machine discovery also serves the authenticated withdrawal tombstone.
    assert.deepEqual(filtered.listings.map((l: { listingId: string }) => l.listingId), ["interop-active", "interop-revoked"]);
    const tiered = await (await listingsRoute.GET(new NextRequest(
      "https://directory.test/api/dacs/listings?identityTier=self-declared",
    ))).json();
    assert.deepEqual(tiered.listings.map((l: { listingId: string }) => l.listingId), ["interop-active", "interop-revoked"]);
    for (const requested of [claim, presentedBy]) {
      const params = { params: Promise.resolve({ listingId: "interop-active", version: "1" }) };
      const detail = await inspectRoute.GET(new NextRequest(
        `https://directory.test/api/dacs/inspect-service/interop-active/1?seller=${encodeURIComponent(requested)}`,
      ), params);
      assert.equal(detail.status, 200, `inspect-service for ${requested}`);
      const envelope = await detail.json();
      assert.ok(envelope.source.url.endsWith(`?seller=${encodeURIComponent(claim)}`), envelope.source.url);
      const listing = await listingRoute.GET(new NextRequest(
        `https://directory.test/api/dacs/listings/interop-active/1?seller=${encodeURIComponent(requested)}`,
      ), { params: Promise.resolve({ listingId: "interop-active", version: "1" }) });
      assert.equal(listing.status, 200, `listing detail for ${requested}`);
      assert.match(listing.headers.get("link") ?? "", new RegExp(`/service/${encodeURIComponent(claim)}/interop-active/1>`));
    }
  });
}
