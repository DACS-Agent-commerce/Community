import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

import { isAnchorReceipt, isListing } from "@kynesyslabs/dacs/artifacts";
import { contentHash, listingAddress } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import type { ListingSummary, SellerRecord } from "../src/catalog/types.js";

// Directory listing admission against what the pinned SDK defines for a
// Listing: DPA-1 verification methods, transaction readiness (only the SDK's
// ordered reader grants it), and CORE §5.1 anchor receipts.
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-listing-admission-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
const store = await import("../src/catalog/store.js");
const { verifyListingResult } = await import("../src/catalog/listingVerification.js");
const { indexRegistration } = await import("../src/catalog/indexer.js");
const { DIRECTORY_TRANSACTION_READINESS, buildDirectoryServiceProfile } = await import("../src/catalog/inspection.js");
const { listingAnchorReceiptRejection } = await import("../src/catalog/listingFinality.js");
const { GET: listingsGet } = await import("../app/api/dacs/listings/route.js");
const { GET: sellerGet } = await import("../app/api/dacs/sellers/[primaryClaimRef]/route.js");

test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));

type Obj = Record<string, unknown>;
const seed = Uint8Array.from(Buffer.alloc(32, 41));
const privateKey = privateKeyFromSeed(seed);
const keyHex = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex");
const seller = `did:demos:agent:${keyHex}`;
const sign = (message: string) => Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKey)).toString("base64url");

const ATTESTED_PIPELINE = [
  { kind: "negotiate-fixed-price" },
  { kind: "commit-agreement" },
  { kind: "pay-dem", parameters: { rail: "pay-dem" } },
  { kind: "deliver-attested-payload" },
];
const attested = (verificationMethod?: unknown): Obj => ({
  kind: "attested-payload",
  payloadFormat: "application/json",
  ...(verificationMethod === undefined ? {} : { verificationMethod }),
});

/** A correctly signed current Listing; only the supplied fields vary. */
function signedListing(listingId: string, deliverable: Obj, extra: Obj = {}): Obj {
  const identity: Obj = { bundleVersion: "1", presentedBy: seller, presentedAt: 1, claims: [{ ref: seller }] };
  identity.presentation = {
    kind: "per-claim",
    signatures: [{ ref: seller, signature: sign(`dacs-bundle-presentation:v1:${contentHash(identity)}`) }],
  };
  const scope: Obj = {
    dacsVersion: "1",
    listingVersion: 1,
    listingId,
    seller: { identity, displayName: "Admission Desk" },
    offering: { title: listingId, description: "Admission fixture.", category: "services.test", tags: [], deliverable },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: ATTESTED_PIPELINE,
    pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } },
    acceptedRails: [{ railId: "pay-dem" }],
    terms: {},
    validity: { notBefore: 1 },
    ...extra,
  };
  return { ...scope, signature: { algorithm: "ed25519", signer: seller, value: sign(`dacs-listing:v1:${contentHash(scope)}`) } };
}

// DACS-2 §7.4.1: the SDK's closed registry, one valid instance per variant.
const REGISTERED_METHODS: Obj[] = [
  { kind: "verifiable-credential" },
  { kind: "tlsnotary", endpoint: "https://notary.example/session" },
  { kind: "zktls", provider: "reclaim", programId: "program-1" },
  { kind: "consensus-backed-proxy", endpoint: { method: "GET", urlTemplate: "https://api.example/{jobId}" } },
  { kind: "oauth-attested", provider: "github", scopes: ["read:user"], maxTokenAgeSec: 300 },
  { kind: "evm-rpc", chainId: 1, contract: `0x${"ab".repeat(20)}`, method: "balanceOf" },
  { kind: "domain-tls-control", challengeType: "dns-01" },
  { kind: "self-signed" },
  { kind: "demos-gcr-domain" },
];

test("admission accepts every registered structured verification method", async () => {
  for (const method of REGISTERED_METHODS) {
    const listing = signedListing("registered-method", attested(method));
    assert.equal(isListing(listing), true, String(method.kind));
    const result = await verifyListingResult(listing);
    assert.equal(result.ok, true, String(method.kind));
  }
});

test("admission rejects each DPA-1 verification-method failure, even when signed", async () => {
  const rejected: Record<string, Obj> = {
    "missing on an attested-payload pipeline": signedListing("missing-method", attested()),
    "free-form string": signedListing("string-method", attested("x402-receipt")),
    "unregistered structured kind": signedListing("unregistered-method", attested({ kind: "llm-judge" })),
    "registered kind without its parameters": signedListing("tlsnotary-no-endpoint", attested({ kind: "tlsnotary" })),
    "registered kind with malformed parameters": signedListing("evm-rpc-bad-contract", attested({
      kind: "evm-rpc", chainId: 1, contract: "0xnot-an-address", method: "balanceOf",
    })),
    "attested phase on a non-attested deliverable": signedListing("storage-deliverable", { kind: "storage-program" }),
    "invalid method outside an attested phase": signedListing("external-method", {
      kind: "external", description: "Manual delivery", verificationMethod: { kind: "llm-judge" },
    }, { pipeline: [...ATTESTED_PIPELINE.slice(0, 3), { kind: "deliver-storage-program" }] }),
  };
  for (const [label, listing] of Object.entries(rejected)) {
    assert.deepEqual(await verifyListingResult(listing), { ok: false, code: "VERIFICATION_METHOD_INVALID" }, label);
  }
  // Other normative failures keep their own class rather than becoming method failures.
  assert.deepEqual(
    await verifyListingResult(signedListing("bad-pricing", attested({ kind: "self-signed" }), { pricing: { kind: "barter" } })),
    { ok: false, code: "NORMATIVE_LISTING_INVALID" },
  );
});

test("the indexer excludes verification-method failures with diagnostics and admits the conforming listing", async () => {
  const anchors = {
    [`stor-${"1".repeat(40)}`]: signedListing("string-method", attested("x402-receipt")),
    [`stor-${"2".repeat(40)}`]: signedListing("missing-method", attested()),
    [`stor-${"3".repeat(40)}`]: signedListing("structured-method", attested({ kind: "self-signed" })),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const data = anchors[String(input).split("/").pop() ?? ""];
    return data
      ? Response.json({ success: true, owner: `0x${keyHex}`, programName: "opaque", data })
      : new Response(null, { status: 404 });
  };
  try {
    const record = await indexRegistration(
      { primaryClaim: seller, displayName: "Admission Desk", listingAnchors: Object.keys(anchors) },
      undefined,
      async () => { throw new Error("identity unavailable"); },
    );
    assert.deepEqual(record.listings.map((listing) => listing.listingId), ["structured-method"]);
    assert.equal(record.listings[0].status, "active");
    assert.deepEqual(record.listings[0].transactionReadiness, DIRECTORY_TRANSACTION_READINESS);

    const diagnostics = store.indexerDiagnostics().listingRejectionDiagnostics;
    assert.equal(diagnostics.byCode.VERIFICATION_METHOD_INVALID, 2);
    assert.deepEqual(
      diagnostics.items.map(({ locator, listingId, listingVersion, code }) => ({ locator, listingId, listingVersion, code }))
        .sort((left, right) => left.locator.localeCompare(right.locator)),
      [
        { locator: `stor-${"1".repeat(40)}`, listingId: "string-method", listingVersion: 1, code: "VERIFICATION_METHOD_INVALID" },
        { locator: `stor-${"2".repeat(40)}`, listingId: "missing-method", listingVersion: 1, code: "VERIFICATION_METHOD_INVALID" },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("published summaries never claim transaction readiness the Directory did not assess", async () => {
  const summary = (listingId: string, transactionReadiness?: unknown): ListingSummary => ({
    listingId,
    version: 1,
    contentHash: "c".repeat(64),
    anchor: { kind: "storage-program", locator: `stor-${"4".repeat(40)}` },
    seller: { primaryClaim: seller, displayName: "Admission Desk" },
    offering: { title: listingId, category: "services.test", tags: [] },
    pricing: {},
    status: "active",
    catalogObservedAt: 1,
    ...(transactionReadiness === undefined ? {} : { transactionReadiness }),
  } as ListingSummary);
  const forged = summary("forged-ready", { disposition: "ready", reason: "stored by an older or hostile writer" });
  const record: SellerRecord = {
    primaryClaim: seller,
    displayName: "Admission Desk",
    cci: [],
    listings: [forged, summary("readiness-absent")],
    deals: [],
    reputation: { completed: 0, bundleCount: 0, totalAgreements: 0, completionRate: null },
    registeredAt: 1,
    lastIndexedAt: 1,
  } as SellerRecord;
  store.saveCatalog({ catalogVersion: "1", generatedAt: 2, sellers: [record] });

  const catalog = await (await listingsGet(new NextRequest("https://directory.example/api/dacs/listings"))).json();
  const sellerView = await (await sellerGet(
    new NextRequest(`https://directory.example/api/dacs/sellers/${encodeURIComponent(seller)}`),
    { params: Promise.resolve({ primaryClaimRef: encodeURIComponent(seller) }) },
  )).json();
  for (const published of [...catalog.listings, ...sellerView.listings]) {
    assert.deepEqual(published.transactionReadiness, DIRECTORY_TRANSACTION_READINESS, published.listingId);
  }
  assert.equal(catalog.listings.length, 2);
  assert.equal(sellerView.listings.length, 2);
  assert.deepEqual(
    buildDirectoryServiceProfile("https://directory.example", forged).transactionReadiness,
    DIRECTORY_TRANSACTION_READINESS,
  );
});

test("registration admits only an SDK-shaped, established, finalized receipt for this exact write", () => {
  const listingContentHash = "d".repeat(64);
  const expected = {
    anchorAddress: `stor-${"5".repeat(40)}`,
    logicalAddress: listingAddress(seller, "receipt-listing", 1),
    listingContentHash,
    sellerClaim: seller,
    transactionRef: "e".repeat(64),
  };
  const receipt: Obj = {
    receiptVersion: "1",
    substrate: "demos",
    finalityProfile: "demos-bft-confirmed-native-read",
    logicalAddress: expected.logicalAddress,
    nativeAddress: expected.anchorAddress,
    contentHash: listingContentHash,
    transactionRef: { kind: "demos-storage-program", value: expected.transactionRef },
    writer: seller,
    nonce: "7",
    state: "finalized",
    observationDisposition: "established",
    observedAt: 1_786_360_000_000,
    blockRef: { id: "block-5", height: "5", timestamp: 1_786_360_000_000 },
    evidence: { kind: "demos-bft-write-proof-v1", value: "proof" },
  };
  assert.equal(isAnchorReceipt(receipt), true);
  assert.equal(listingAnchorReceiptRejection(receipt, expected), null);

  const { blockRef: _blockRef, ...withoutBlock } = receipt;
  const { evidence: _evidence, ...withoutEvidence } = receipt;
  const rejections: Record<string, [Obj, RegExp]> = {
    "missing evidence": [withoutEvidence, /not a CORE §5\.1 AnchorReceipt/],
    "unknown member": [{ ...receipt, trustLevel: "high" }, /not a CORE §5\.1 AnchorReceipt/],
    "finalized without a block": [withoutBlock, /not a CORE §5\.1 AnchorReceipt/],
    "included, not finalized": [{ ...receipt, state: "included" }, /does not establish a finalized write/],
    "indeterminate observation": [
      { ...receipt, observationDisposition: "indeterminate", preservedReceiptHash: "f".repeat(64) },
      /does not establish a finalized write/,
    ],
    "another logical address": [{ ...receipt, logicalAddress: listingAddress(seller, "receipt-listing", 2) }, /does not bind/],
    "another native address": [{ ...receipt, nativeAddress: `stor-${"6".repeat(40)}` }, /does not bind/],
    "another content hash": [{ ...receipt, contentHash: "0".repeat(64) }, /does not bind/],
    "another writer": [{ ...receipt, writer: `did:demos:agent:${"7".repeat(64)}` }, /does not bind/],
    "another transaction": [{ ...receipt, transactionRef: { kind: "demos-storage-program", value: "1".repeat(64) } }, /does not bind/],
  };
  for (const [label, [candidate, reason]] of Object.entries(rejections)) {
    assert.match(listingAnchorReceiptRejection(candidate, expected) ?? "admitted", reason, label);
  }
});
