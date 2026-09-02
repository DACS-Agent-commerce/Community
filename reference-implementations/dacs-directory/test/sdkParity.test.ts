import assert from "node:assert/strict";
import test from "node:test";

import { contentHash } from "@kynesyslabs/dacs/canonical";
import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
  signedBytes,
} from "@kynesyslabs/dacs/crypto";
import {
  ARTIFACT_SEPARATORS,
  type IdentityBundle,
  type Listing,
} from "@kynesyslabs/dacs/artifacts";
import { queryListingCatalog } from "@kynesyslabs/dacs/discovery";
import { identityBundleHash } from "@kynesyslabs/dacs/identity";

import { publicKeyForClaim, verifyListing } from "../src/catalog/listingVerification.js";
import { verifyReferencedArtifactSignature } from "../src/catalog/bundlePolicy.js";
import {
  parseCreateAnchorCandidate,
  projectDiscoveredAnchors,
} from "../src/catalog/scan.js";
import type { RawAnchorObservation } from "../src/catalog/types.js";

const seed = Uint8Array.from(Buffer.alloc(32, 19));
const privateKey = privateKeyFromSeed(seed);
const did = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;

async function normativeListing(): Promise<Listing> {
  const unsignedIdentity = {
    bundleVersion: "1" as const,
    presentedBy: did,
    presentedAt: 1_790_000_000_000,
    claims: [{ ref: did }],
  };
  const identityForHash: IdentityBundle = {
    ...unsignedIdentity,
    presentation: { kind: "per-claim", signatures: [] },
  };
  const identitySignature = Buffer.from(await ed25519Sign(
    signedBytes("dacs-bundle-presentation:v1:", identityBundleHash(identityForHash)),
    privateKey,
  )).toString("base64url");
  const identity: IdentityBundle = {
    ...unsignedIdentity,
    presentation: {
      kind: "per-claim",
      signatures: [{ ref: did, signature: identitySignature }],
    },
  };
  const draft = {
    dacsVersion: "1" as const,
    listingVersion: 1,
    listingId: "current-service",
    seller: { identity, displayName: "Current Agent" },
    offering: {
      title: "Current service",
      description: "A current SDK Listing",
      category: "services.testing",
      tags: ["sdk"],
      deliverable: { kind: "storage-program" as const, accessModel: "public" as const },
    },
    buyerRequirement: { requirementVersion: "1" as const, required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" as const },
      { kind: "commit-agreement" as const },
      { kind: "deliver-storage-program" as const },
    ],
    pricing: {
      kind: "fixed" as const,
      price: { amount: "1", currency: "DEM" },
    },
    terms: {},
    validity: { notBefore: 1_780_000_000_000, notAfter: 1_800_000_000_000 },
  };
  const signature = Buffer.from(await ed25519Sign(
    signedBytes(ARTIFACT_SEPARATORS.Listing, contentHash(draft)),
    privateKey,
  )).toString("base64url");
  return {
    ...draft,
    signature: { algorithm: "ed25519", signer: did, value: signature },
  };
}

test("current SDK Listing passes the ordered directory validation path", async () => {
  const listing = await normativeListing();
  const result = await verifyListing(listing as unknown as Record<string, unknown>, {
    nowMs: 1_790_000_000_000,
  });
  assert.equal(result?.profile, "current");
  assert.equal(result?.contentHash, contentHash(listing as unknown as Record<string, unknown>));
  assert.equal(await verifyReferencedArtifactSignature({
    kind: "dacs-1-listing",
    raw: listing as unknown as Record<string, unknown>,
  }), true);
});

test("a Listing cannot promote its own payment rail into PA-1 authority", async () => {
  const base = await normativeListing();
  const { signature: _signature, ...draft } = base;
  const hostileDraft = {
    ...draft,
    pipeline: [
      { kind: "negotiate-fixed-price" as const },
      { kind: "commit-agreement" as const },
      { kind: "pay-x402" as const, parameters: { rail: "attacker:fake-x402" } },
      { kind: "deliver-storage-program" as const },
    ],
    acceptedRails: [{ railId: "attacker:fake-x402", railVersion: 999 }],
  };
  const signature = Buffer.from(await ed25519Sign(
    signedBytes(ARTIFACT_SEPARATORS.Listing, contentHash(hostileDraft)),
    privateKey,
  )).toString("base64url");
  const hostile = {
    ...hostileDraft,
    signature: { algorithm: "ed25519" as const, signer: did, value: signature },
  };
  assert.equal(await verifyListing(hostile as unknown as Record<string, unknown>, {
    nowMs: 1_790_000_000_000,
  }), null);
});

test("attested payload admission is limited to locally configured methods", async () => {
  const base = await normativeListing();
  const { signature: _signature, ...draft } = base;
  const unsupportedDraft = {
    ...draft,
    offering: {
      ...draft.offering,
      deliverable: {
        kind: "attested-payload" as const,
        payloadFormat: "application/json",
        verificationMethod: { kind: "zktls" as const, provider: "unknown", programId: "unknown" },
      },
    },
    pipeline: [
      { kind: "negotiate-fixed-price" as const },
      { kind: "commit-agreement" as const },
      { kind: "deliver-attested-payload" as const },
    ],
  };
  const signature = Buffer.from(await ed25519Sign(
    signedBytes(ARTIFACT_SEPARATORS.Listing, contentHash(unsupportedDraft)),
    privateKey,
  )).toString("base64url");
  assert.equal(await verifyListing({
    ...unsupportedDraft,
    signature: { algorithm: "ed25519", signer: did, value: signature },
  } as unknown as Record<string, unknown>, { nowMs: 1_790_000_000_000 }), null);
});

test("signer resolution rejects implicit suffix-key aliases", () => {
  assert.ok(publicKeyForClaim(did));
  assert.equal(publicKeyForClaim(`did:ethr:${did.slice(-64)}`), null);
});

test("global scanner classifies logical metadata and ignores opaque program names", () => {
  const logicalAddress = `dacs1:${did.replaceAll(":", "%3A")}:current-service:v1`;
  const base = {
    id: 9,
    hash: "a".repeat(64),
    status: "confirmed",
    blockNumber: 10,
  };
  const current = parseCreateAnchorCandidate({
    ...base,
    content: JSON.stringify({
      type: "storageProgram",
      from: `0x${did.slice(-64)}`,
      to: `stor-${"b".repeat(40)}`,
      data: ["storageProgram", {
        operation: "CREATE_STORAGE_PROGRAM",
        storageAddress: `stor-${"b".repeat(40)}`,
        programName: logicalAddress.replaceAll(":", "%3A"),
        metadata: { logicalAddress },
      }],
    }),
  });
  assert.equal(current?.kind, "listing");
  assert.equal(current?.logicalAddress, logicalAddress);

  const opaqueOnly = parseCreateAnchorCandidate({
    ...base,
    content: JSON.stringify({
      type: "storageProgram",
      from: `0x${did.slice(-64)}`,
      to: `stor-${"c".repeat(40)}`,
      data: ["storageProgram", {
        operation: "CREATE_STORAGE_PROGRAM",
        storageAddress: `stor-${"c".repeat(40)}`,
        programName: logicalAddress.replaceAll(":", "%3A"),
      }],
    }),
  });
  assert.equal(opaqueOnly, null);
});

test("raw bundle anchors rebuild a two-sided discovered deal", () => {
  const buyer = `did:demos:agent:${"1".repeat(64)}`;
  const seller = `did:demos:agent:${"2".repeat(64)}`;
  const observation = (
    role: "buyer" | "seller",
    nativeAddress: string,
  ): RawAnchorObservation => ({
    nativeAddress,
    logicalAddress: `stor-${(role === "buyer" ? "a" : "b").repeat(64)}`,
    owner: `0x${(role === "buyer" ? "1" : "2").repeat(64)}`,
    kind: "bundle",
    observedAt: 1,
    readStatus: "read",
    compatibility: "current",
    contentHash: "c".repeat(64),
    data: {
      jobId: "job-1",
      anchoredByRole: role,
      parties: [
        { role: "buyer", primaryClaim: buyer },
        { role: "seller", primaryClaim: seller },
      ],
    },
  });
  const buyerRef = `stor-${"3".repeat(40)}`;
  const sellerRef = `stor-${"4".repeat(40)}`;
  const projected = projectDiscoveredAnchors([
    observation("buyer", buyerRef),
    observation("seller", sellerRef),
  ]);
  assert.deepEqual(projected.deals.get("job-1"), {
    jobId: "job-1",
    rail: "unknown",
    buyerBundleRef: buyerRef,
    sellerBundleRef: sellerRef,
    owners: { buyer, seller },
  });
});

test("catalog output is accepted by the current SDK client contract", async () => {
  const listing = await normativeListing();
  const hash = contentHash(listing as unknown as Record<string, unknown>);
  const result = await queryListingCatalog(
    {
      catalogUrl: "http://directory.test/api/dacs/listings",
      allowInsecureHttp: true,
      fetchImpl: async () => new Response(JSON.stringify({
        listings: [{
          listingId: listing.listingId,
          version: listing.listingVersion,
          contentHash: hash,
          anchor: { kind: "storage-program", locator: `stor-${"d".repeat(40)}` },
          seller: { primaryClaim: did, displayName: "Current Agent" },
          offering: { title: "Current service", category: "services.testing", tags: ["sdk"] },
          pricing: { priceHint: "1", currency: "DEM" },
          status: "active",
          catalogObservedAt: 1_790_000_000_000,
          reputationHint: {
            categoryScope: "services.testing",
            completionRate: null,
            averageSellerRating: null,
            bundleCount: 0,
            windowStart: 0,
            windowEnd: 1_790_000_000_000,
            computedAt: 1_790_000_000_000,
          },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    },
    {},
  );
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.equal(result.page.listings.length, 1);
});
