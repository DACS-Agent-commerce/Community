import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";

// A reply the node sent but raw admission refused never succeeds on retry: the listing route answers
// 503 like an outage and carries the reason, so the caller can tell the two apart.
process.env.DACS_DIRECTORY_DATA = mkdtempSync(join(tmpdir(), "dacs-directory-listing-refused-"));
process.env.DEMOS_RPC = "https://node.test";
const { indexRegistration } = await import("../src/catalog/indexer.js");
const store = await import("../src/catalog/store.js");
const listingRoute = await import("../app/api/dacs/listings/[listingId]/[version]/route.js");

const seed = Uint8Array.from(Buffer.alloc(32, 0x53));
const privateKey = privateKeyFromSeed(seed);
const claim = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const sign = (message: string) => Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKey)).toString("base64url");
const locator = `stor-${"5".repeat(40)}`;

const identity: Record<string, unknown> = { bundleVersion: "1", presentedBy: claim, presentedAt: 1, claims: [{ ref: claim, kind: "signing-key" }] };
identity.presentation = { kind: "per-claim", signatures: [{ ref: claim, signature: sign(`dacs-bundle-presentation:v1:${contentHash(identity)}`) }] };
const scope = {
  dacsVersion: "1", listingVersion: 1, listingId: "refused-reply",
  seller: { displayName: "Refused seller", identity },
  offering: { title: "refused", description: "refused reply", category: "conformance.signature", tags: [], deliverable: { kind: "storage-program" } },
  buyerRequirement: { requirementVersion: "1", required: [] },
  pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }, { kind: "deliver-storage-program" }],
  pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } },
  acceptedRails: [{ railId: "demos-native:DEM" }],
  terms: {}, validity: { notBefore: 1 },
};
const listing = { ...scope, signature: { algorithm: "ed25519", signer: claim, value: sign(`dacs-listing:v1:${contentHash(scope)}`) } };

test("the listing route answers 503 with the reason when the stored reply is refused", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ success: true, owner: `0x${claim.slice(-64)}`, programName: "opaque", data: listing });
    const record = await indexRegistration(
      { primaryClaim: claim, displayName: "Refused seller", listingAnchors: [locator] },
      undefined,
      async () => { throw new Error("identity unavailable"); },
    );
    assert.equal(record.listings.length, 1);
    store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [record] });

    const duplicateMember = JSON.stringify({ success: true, data: listing }).replace('"listingId":"refused-reply"', '"listingId":"refused-reply","listingId":"refused-reply"');
    globalThis.fetch = async () => new Response(duplicateMember);
    const response = await listingRoute.GET(
      new NextRequest("https://directory.test/api/dacs/listings/refused-reply/1"),
      { params: Promise.resolve({ listingId: "refused-reply", version: "1" }) },
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "listing anchor unavailable: the Demos node could not be read",
      reason: "storage reply refused by raw JSON admission: DUPLICATE-MEMBER",
    });
  } finally { globalThis.fetch = original; }
});
