import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { registrationMessage } from "../src/catalog/registrationSig.js";
import type { Registration, ListingSummary, SellerRecord } from "../src/catalog/types.js";

// Directory listing admission against what the pinned SDK defines for a
// Listing: DPA-1 verification methods, transaction readiness (only the SDK's
// ordered reader grants it) and catalog projection.
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-listing-admission-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
const store = await import("../src/catalog/store.js");
const { indexRegistration } = await import("../src/catalog/indexer.js");
const { DIRECTORY_TRANSACTION_READINESS, buildDirectoryServiceProfile } = await import("../src/catalog/inspection.js");
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

/** A correctly signed current Listing; only its id and deliverable vary. */
function signedListing(listingId: string, deliverable: Obj): Obj {
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
  };
  return { ...scope, signature: { algorithm: "ed25519", signer: seller, value: sign(`dacs-listing:v1:${contentHash(scope)}`) } };
}

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
        { locator: `stor-${"1".repeat(40)}`, listingId: undefined, listingVersion: undefined, code: "VERIFICATION_METHOD_INVALID" },
        { locator: `stor-${"2".repeat(40)}`, listingId: undefined, listingVersion: undefined, code: "VERIFICATION_METHOD_INVALID" },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unreadable listing anchors retain rejection notices and history until admission or removal", async () => {
  const anchor = `stor-${"9".repeat(40)}`;
  const invalid = signedListing("retry-notice", attested("x402-receipt"));
  const valid = signedListing("retry-notice", attested({ kind: "self-signed" }));
  const reg = { primaryClaim: seller, displayName: "Retry Desk", listingAnchors: [anchor] };
  let response: Obj | number = invalid;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => typeof response === "number"
    ? new Response(null, { status: response })
    : Response.json({ success: true, owner: `0x${keyHex}`, programName: "opaque", data: response });
  const index = () => indexRegistration(reg, undefined, async () => ({}));
  const diagnostic = () => store.indexerDiagnostics().listingRejectionDiagnostics.items.find((item) => item.locator === anchor);
  try {
    await index();
    // A previously authenticated public notice must survive a transport failure too.
    store.recordListingRejection(anchor, seller, "VERIFICATION_METHOD_INVALID", { listingId: "retry-notice", listingVersion: 1 }, true);
    const before = diagnostic();
    assert.ok(before?.publicNotice);
    for (const status of [503, 404]) {
      response = status;
      assert.deepEqual((await index()).listings, []);
      assert.deepEqual(diagnostic(), before, `HTTP ${status} does not erase or advance diagnostic history`);
    }
    response = invalid;
    await index();
    assert.equal(diagnostic()?.occurrences, before.occurrences + 1);
    assert.equal(diagnostic()?.firstSeenAt, before.firstSeenAt);
    response = valid;
    assert.equal((await index()).listings.length, 1);
    assert.equal(diagnostic(), undefined, "successful admission clears the notice");
    response = invalid;
    await index();
    assert.ok(diagnostic());
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
    { params: Promise.resolve({ primaryClaimRef: seller }) },
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

test("a declared content hash mismatch excludes a listing and a corrected declaration clears its diagnostic", async () => {
  const at = `stor-${"e".repeat(40)}`;
  const listing = signedListing("declared-hash", attested({ kind: "self-signed" }));
  const { signature: _signature, ...scope } = listing;
  const hash = contentHash(scope);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => String(input).endsWith(at)
    ? Response.json({ success: true, owner: `0x${keyHex}`, programName: "opaque", data: listing })
    : new Response(null, { status: 404 });
  try {
    const registration = { primaryClaim: seller, displayName: "Admission Desk", listingAnchors: [at] };
    const mismatch = await indexRegistration({ ...registration, listingContentHashes: { [at]: "f".repeat(64) } });
    assert.equal(mismatch.listings.length, 0);
    assert.ok(store.indexerDiagnostics().listingRejectionDiagnostics.items.some((item) =>
      item.locator === at && item.code === "DECLARED_CONTENT_HASH_MISMATCH" && item.listingId === "declared-hash"));
    const corrected = await indexRegistration({ ...registration, listingContentHashes: { [at]: `sha256-${hash.toUpperCase()}` } });
    assert.equal(corrected.listings.length, 1);
    assert.equal(corrected.listings[0].contentHash, hash);
    assert.ok(!store.indexerDiagnostics().listingRejectionDiagnostics.items.some((item) => item.locator === at));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("complete-pass pruning keeps listed pointers case-insensitively and removes unlisted pointers and departed sellers", () => {
  const keepAt = `stor-${"d".repeat(40)}`, dropAt = `stor-${"e".repeat(40)}`, unlistedAt = `stor-${"7".repeat(40)}`;
  const other = `did:demos:agent:${"f".repeat(64)}`;
  store.recordListingRejection(keepAt, seller, "LISTING_SIGNATURE_INVALID");
  store.recordListingRejection(unlistedAt, seller, "LISTING_SIGNATURE_INVALID");
  store.recordListingRejection(dropAt, other, "LISTING_SIGNATURE_INVALID");
  store.pruneListingRejections([{ primaryClaim: seller.toUpperCase(), listingAnchors: [keepAt] }]);
  const locators = store.indexerDiagnostics().listingRejectionDiagnostics.items.map((item) => item.locator);
  assert.ok(locators.includes(keepAt));
  assert.equal(locators.includes(unlistedAt), false);
  assert.equal(locators.includes(dropAt), false);
  store.clearRegistrationListingRejections(seller);
});

test("rejections never assign unauthenticated coordinates or blame another seller", async () => {
  const anchor = `stor-${"a".repeat(40)}`;
  const other = `did:demos:agent:${"f".repeat(64)}`;
  let data = signedListing("valid-seller", attested({ kind: "self-signed" }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ success: true, owner: `0x${keyHex}`, programName: "opaque", data });
  const reg = { primaryClaim: seller, displayName: "Seller", listingAnchors: [anchor] };
  try {
    const wrong = await indexRegistration({ ...reg, primaryClaim: other }, undefined, async () => ({}));
    assert.equal(wrong.listings.length, 0);
    let diagnostic = store.indexerDiagnostics().listingRejectionDiagnostics.items.find((item) => item.locator === anchor)!;
    assert.equal(diagnostic.code, "SELLER_CLAIM_BINDING");
    assert.equal(diagnostic.listingId, undefined);
    assert.equal(diagnostic.publicNotice, false);
    assert.equal((await indexRegistration(reg, undefined, async () => ({}))).listings[0].listingId, "valid-seller");
    data = { ...data, signature: { algorithm: "ed25519", signer: seller, value: "junk" } };
    await indexRegistration(reg, undefined, async () => ({}));
    diagnostic = store.indexerDiagnostics().listingRejectionDiagnostics.items.find((item) => item.locator === anchor)!;
    assert.equal(diagnostic.listingId, undefined);
    assert.equal(diagnostic.publicNotice, false);
  } finally {
    globalThis.fetch = originalFetch;
    store.pruneListingRejections([]);
  }
});

const unverifiableReads: Record<string, (valid: Obj) => Obj> = {
  "invalid shape": () => ({ dacsVersion: "1" }),
  "invalid signature": (valid) => ({ ...valid, signature: { algorithm: "ed25519", signer: seller, value: "invalid" } }),
  "oversized canonical listing": (valid) => ({ ...valid, extension: "x".repeat(16_384) }),
};

for (const [kind, invalidRead] of Object.entries(unverifiableReads)) {
  test(`an authenticated owner notice survives repeated present reads with ${kind}`, async () => {
    const anchor = `stor-${"6".repeat(40)}`;
    const valid = signedListing("retained-owner", attested({ kind: "self-signed" }));
    let data = valid;
    let anchorOwner = `0x${"f".repeat(64)}`;
    const reg: Registration = { primaryClaim: seller, displayName: "Seller", listingAnchors: [anchor] };
    const message = registrationMessage(reg, 1);
    reg.ownerSignature = { message, signedAt: 1, signature: sign(message) };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ success: true, owner: anchorOwner, data });
    const index = () => indexRegistration(reg, undefined, async () => ({}));
    const notice = () => store.indexerDiagnostics().listingRejectionDiagnostics.items.find((item) => item.locator === anchor);
    try {
      assert.equal((await index()).listings.length, 0);
      const before = notice();
      assert.equal(before?.code, "OWNER_CLAIM_BINDING");
      assert.equal(before?.publicNotice, true);
      data = invalidRead(valid);
      for (let repeat = 0; repeat < 2; repeat++) {
        assert.equal((await index()).listings.length, 0);
        assert.deepEqual(notice(), before, "unverifiable bytes cannot replace authenticated coordinates or history");
      }
      data = valid;
      anchorOwner = `0x${keyHex}`;
      assert.equal((await index()).listings.length, 1);
      assert.equal(notice(), undefined, "a verified correction reconciles the owner notice");
    } finally {
      globalThis.fetch = originalFetch;
      store.clearRegistrationListingRejections(seller);
    }
  });
}
