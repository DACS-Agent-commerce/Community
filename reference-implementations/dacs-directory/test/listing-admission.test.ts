import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

import { isListing } from "@kynesyslabs/dacs/artifacts";
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
const { verifyListingResult } = await import("../src/catalog/listingVerification.js");
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

/** ClaimReference bytes for each signed role; all name the same key by default. */
interface ListingRefs { presentedBy: string; claim: string; signer: string }

/** A correctly signed current Listing; only the supplied fields vary. */
function signedListing(
  listingId: string,
  deliverable: Obj,
  extra: Obj = {},
  refs: ListingRefs = { presentedBy: seller, claim: seller, signer: seller },
): Obj {
  const identity: Obj = { bundleVersion: "1", presentedBy: refs.presentedBy, presentedAt: 1, claims: [{ ref: refs.claim }] };
  identity.presentation = {
    kind: "per-claim",
    signatures: [{ ref: refs.presentedBy, signature: sign(`dacs-bundle-presentation:v1:${contentHash(identity)}`) }],
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
  return { ...scope, signature: { algorithm: "ed25519", signer: refs.signer, value: sign(`dacs-listing:v1:${contentHash(scope)}`) } };
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
        { locator: `stor-${"1".repeat(40)}`, listingId: undefined, listingVersion: undefined, code: "VERIFICATION_METHOD_INVALID" },
        { locator: `stor-${"2".repeat(40)}`, listingId: undefined, listingVersion: undefined, code: "VERIFICATION_METHOD_INVALID" },
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

// Conforming Listings that the previous SDK pin (f68fed1) refused: APR-1
// pay-alternative, CORE CF-5 nesting through 128 levels, and CORE B.1 CF-3
// advisory ClaimReference parameters. Admission never accepts what the SDK
// refuses; the catalog profile still refuses pay-alternative pipelines.
const ALTERNATIVES = [{ railId: "pay-dem" }, { railId: "pay-x402" }];
const alternativePipeline = (alternatives: Obj[]): Obj[] => [
  ...ATTESTED_PIPELINE.slice(0, 2),
  { kind: "pay-alternative", parameters: { alternatives } },
  ATTESTED_PIPELINE[3],
];
const payAlternative = (listingId: string, extra: Obj = {}): Obj => signedListing(listingId, attested({ kind: "self-signed" }), {
  pipeline: alternativePipeline(ALTERNATIVES),
  acceptedRails: ALTERNATIVES,
  ...extra,
});
/** A Listing whose deepest member sits `levels` containers deep, the Listing itself included. */
const nestedListing = (levels: number): Obj => {
  let member: unknown = "leaf";
  for (let level = 2; level < levels; level += 1) member = { n: member };
  return signedListing(`depth-${levels}`, attested({ kind: "self-signed" }), { terms: { extension: member } });
};
const advisory = `${seller}?channel=directory`;

test("the catalog profile refuses an APR-1 pay-alternative listing that the SDK reader accepts", async () => {
  const listing = payAlternative("pay-alternative");
  assert.equal(isListing(listing), true);
  assert.deepEqual(await verifyListingResult(listing), { ok: false, code: "NORMATIVE_LISTING_INVALID" });

  const incoherent: Record<string, Obj> = {
    "a single alternative": payAlternative("one-alternative", { pipeline: alternativePipeline(ALTERNATIVES.slice(0, 1)) }),
    "an alternative that is not an accepted rail": payAlternative("unaccepted-alternative", {
      acceptedRails: [ALTERNATIVES[0], { railId: "pay-evm-erc20" }],
    }),
    "an alternative beside a direct pay phase": payAlternative("mixed-pay", {
      pipeline: [...alternativePipeline(ALTERNATIVES).slice(0, 3), ATTESTED_PIPELINE[2], ATTESTED_PIPELINE[3]],
    }),
  };
  for (const [label, candidate] of Object.entries(incoherent)) {
    assert.equal(isListing(candidate), false, label);
    assert.deepEqual(await verifyListingResult(candidate), { ok: false, code: "NORMATIVE_LISTING_INVALID" }, label);
  }
});

test("admission follows CF-5: listings nested through 128 levels are admitted, deeper ones are not", async () => {
  for (const levels of [63, 64, 65, 96, 126, 127, 128, 129, 130]) {
    const listing = levels <= 128 ? nestedListing(levels) : null;
    if (listing) {
      assert.equal(isListing(listing), true, `levels ${levels}`);
      assert.equal((await verifyListingResult(listing)).ok, true, `levels ${levels}`);
      continue;
    }
    // Deeper artifacts have no canonical form, so they cannot even be signed.
    assert.throws(() => nestedListing(levels), `levels ${levels}`);
  }
  // Unsigned bytes past the bound still fail closed rather than throwing.
  const tooDeep = nestedListing(128);
  let leaf = (tooDeep.terms as Obj).extension as Obj;
  while (typeof leaf.n === "object") leaf = leaf.n as Obj;
  leaf.n = { n: "past the bound" };
  assert.equal(isListing(tooDeep), false);
  assert.deepEqual(await verifyListingResult(tooDeep), { ok: false, code: "NORMATIVE_LISTING_INVALID" });
});

test("admission authorizes the signer by CF-3 identity, ignoring advisory ClaimReference parameters", async () => {
  const admitted: Record<string, ListingRefs> = {
    "parameters on every role": { presentedBy: advisory, claim: advisory, signer: advisory },
    "parameters only on the signer": { presentedBy: seller, claim: seller, signer: advisory },
    "parameters only on the claim": { presentedBy: seller, claim: advisory, signer: seller },
    "several canonical parameters": { presentedBy: seller, claim: seller, signer: `${seller}?channel=directory&purpose=listing` },
  };
  for (const [label, refs] of Object.entries(admitted)) {
    const listing = signedListing("advisory-claim", attested({ kind: "self-signed" }), {}, refs);
    assert.equal(isListing(listing), true, label);
    const result = await verifyListingResult(listing);
    assert.equal(result.ok, true, label);
    // The Directory keys sellers by the parameter-free identity.
    assert.equal(result.ok && result.value.signer, seller, label);
    assert.equal(result.ok && result.value.sellerClaim, seller, label);
  }

  // Parameters outside the exact CF-2 form, or another identity, stay refused.
  const otherKey = `did:demos:agent:${"7".repeat(64)}`;
  const refused: Record<string, [ListingRefs, string]> = {
    "parameters out of order": [{ presentedBy: seller, claim: seller, signer: `${seller}?purpose=listing&channel=directory` }, "NORMATIVE_LISTING_INVALID"],
    "an empty parameter list": [{ presentedBy: seller, claim: seller, signer: `${seller}?` }, "NORMATIVE_LISTING_INVALID"],
    "a duplicated parameter": [{ presentedBy: seller, claim: seller, signer: `${seller}?a=1&a=2` }, "NORMATIVE_LISTING_INVALID"],
    "an unreserved escape": [{ presentedBy: seller, claim: seller, signer: `${seller}?channel=%41` }, "NORMATIVE_LISTING_INVALID"],
    "a parameterised claim for another key": [{ presentedBy: seller, claim: `${otherKey}?channel=directory`, signer: seller }, "NORMATIVE_LISTING_INVALID"],
    "a parameterised signer naming another key": [
      { presentedBy: otherKey, claim: otherKey, signer: `${otherKey}?channel=directory` },
      "LISTING_SIGNATURE_INVALID",
    ],
  };
  for (const [label, [refs, code]] of Object.entries(refused)) {
    const listing = signedListing("advisory-claim", attested({ kind: "self-signed" }), {}, refs);
    assert.deepEqual(await verifyListingResult(listing), { ok: false, code }, label);
  }
});

test("the indexer publishes current-SDK listings under the registered identity and drops expired ones", async () => {
  const anchors = {
    [`stor-${"a".repeat(40)}`]: payAlternative("indexed-pay-alternative"),
    [`stor-${"b".repeat(40)}`]: nestedListing(128),
    [`stor-${"c".repeat(40)}`]: signedListing("indexed-advisory", attested({ kind: "self-signed" }), {}, {
      presentedBy: advisory, claim: advisory, signer: advisory,
    }),
    [`stor-${"d".repeat(40)}`]: signedListing("indexed-expired", attested({ kind: "self-signed" }), {
      validity: { notBefore: 1, notAfter: 2 },
    }),
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
    assert.deepEqual(
      record.listings.map((listing) => listing.listingId).sort(),
      ["depth-128", "indexed-advisory"],
    );
    // The seller record is keyed by the registered CF-3 identity; each §6.3.6
    // summary carries its listing's exact `presentedBy` bytes (RB-2).
    assert.equal(record.primaryClaim, seller);
    for (const listing of record.listings) {
      assert.equal(listing.status, "active", listing.listingId);
      assert.equal(
        listing.seller.primaryClaim,
        listing.listingId === "indexed-advisory" ? advisory : seller,
        listing.listingId,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the indexer withholds a signed Listing until its notBefore, then publishes it", async (t) => {
  // DACS-1 reader step 3: a Listing is not effective before validity.notBefore.
  const notBefore = Date.now() + 24 * 60 * 60 * 1000;
  const anchor = `stor-${"e".repeat(40)}`;
  const listing = signedListing("indexed-future", attested({ kind: "self-signed" }), { validity: { notBefore } });
  assert.equal(isListing(listing), true);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => String(input).endsWith(`/${anchor}`)
    ? Response.json({ success: true, owner: `0x${keyHex}`, programName: "opaque", data: listing })
    : new Response(null, { status: 404 });
  const index = () => indexRegistration(
    { primaryClaim: seller, displayName: "Admission Desk", listingAnchors: [anchor] },
    undefined,
    async () => { throw new Error("identity unavailable"); },
  );
  try {
    assert.deepEqual((await index()).listings, []);
    t.mock.method(Date, "now", () => notBefore);
    const effective = await index();
    assert.deepEqual(effective.listings.map((summary) => [summary.listingId, summary.status]), [["indexed-future", "active"]]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejection diagnostics keep every Listing ID the DACS-1 schema allows", async () => {
  const { listingDiagnosticCoordinates } = await import("../src/catalog/listingAdmission.js");
  const { listingRejectionDiagnosticSchema } = await import("../src/catalog/contracts.js");
  const pattern = new RegExp(listingRejectionDiagnosticSchema.properties.listingId.pattern);
  for (const listingId of ["a".repeat(65), "A.b_c~d-".repeat(16), "x"]) {
    assert.deepEqual(listingDiagnosticCoordinates({ listingId, listingVersion: 2 }), { listingId, listingVersion: 2 }, listingId);
    assert.ok(pattern.test(listingId), listingId);
  }
  for (const listingId of ["a".repeat(129), "a/b", "a b", ""]) {
    assert.equal(listingDiagnosticCoordinates({ listingId, listingVersion: 2 }), undefined, listingId);
    assert.equal(pattern.test(listingId), false, listingId);
  }
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

test("diagnostic coordinates preserve current precedence and validate the legacy fallback", async () => {
  const { listingDiagnosticCoordinates: coordinates } = await import("../src/catalog/listingAdmission.js");
  assert.deepEqual(coordinates({ serviceId: "legacy", version: 3 }), { listingId: "legacy", listingVersion: 3 });
  assert.deepEqual(coordinates({ serviceId: "legacy" }), { listingId: "legacy", listingVersion: 1 });
  assert.deepEqual(coordinates({ listingId: "current", listingVersion: 2, serviceId: "legacy", version: 3 }),
    { listingId: "current", listingVersion: 2 });
  for (const raw of [{ serviceId: 123 }, { serviceId: "legacy", version: 0 },
    { serviceId: "legacy", version: -1 }, { listingId: "", serviceId: "legacy" }]) {
    assert.equal(coordinates(raw), undefined);
  }
});

test("malformed attested deliverables retain verification-method diagnostics", async () => {
  for (const extra of [{ offering: undefined }, { offering: {} },
    { offering: { deliverable: { kind: "storage-program", verificationMethod: { kind: "self-signed" } } } },
    { offering: {}, pipeline: [null, 7, [], ...ATTESTED_PIPELINE] }]) {
    assert.deepEqual(await verifyListingResult({ dacsVersion: "1", ...extra, pipeline: extra.pipeline ?? ATTESTED_PIPELINE }),
      { ok: false, code: "VERIFICATION_METHOD_INVALID" });
  }
  assert.deepEqual(await verifyListingResult({ signatures: [] }), { ok: false, code: "LISTING_SIGNATURE_INVALID" });
});

test("exception wrappers preserve their selected profile's rejection code", async () => {
  for (const [raw, code] of [[{ dacsVersion: "1" }, "NORMATIVE_LISTING_INVALID"], [{}, "LEGACY_LISTING_INVALID"]] as const) {
    const throwing = new Proxy(raw, { get() { throw new Error("fixture read failure"); } });
    assert.deepEqual(await verifyListingResult(throwing), { ok: false, code });
  }
});

test("every rejection has a public explanation and coordinate-free diagnostics omit the version", async () => {
  const { LISTING_REJECTION_CODES } = await import("../src/catalog/listingAdmission.js");
  for (const [index, code] of LISTING_REJECTION_CODES.entries()) {
    const at = `stor-${(800 + index).toString(16).padStart(40, "0")}`;
    store.recordListingRejection(at, seller, code);
    const item = store.indexerDiagnostics({ deadLetterLocator: at }).listingRejectionDiagnostics.items[0];
    assert.equal(item.code, code);
    assert.ok(item.message.trim().length > 0, code);
    assert.ok(item.guidance.trim().length > 0, code);
    assert.equal(Object.hasOwn(item, "listingId"), false, code);
    assert.equal(Object.hasOwn(item, "listingVersion"), false, code);
  }
});

test("owner-mismatch diagnostics preserve authenticated coordinates but require a signed registration for public notice", async () => {
  const anchor = `stor-${"c".repeat(40)}`;
  const data = signedListing("owner-mismatch", attested({ kind: "self-signed" }));
  assert.equal((await verifyListingResult(data)).ok, true);
  const reg: Registration = { primaryClaim: seller, displayName: "Seller", listingAnchors: [anchor] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ success: true, owner: `0x${"f".repeat(64)}`, programName: "opaque", data });
  try {
    for (const signed of [false, true]) {
      if (signed) {
        const message = registrationMessage(reg, 1);
        reg.ownerSignature = { message, signedAt: 1, signature: sign(message) };
      }
      const record = await indexRegistration(reg, undefined, async () => ({}));
      assert.deepEqual(record.listings, []);
      const diagnostics = store.indexerDiagnostics({ deadLetterLocator: anchor }).listingRejectionDiagnostics;
      const item = diagnostics.items.find((item) => item.locator === anchor)!;
      assert.equal(item.code, "OWNER_CLAIM_BINDING");
      assert.equal(item.listingId, "owner-mismatch");
      assert.equal(item.listingVersion, 1);
      assert.equal(item.publicNotice, signed);
      assert.equal(diagnostics.publicTotal, signed ? 1 : 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
    store.clearRegistrationListingRejections(seller);
  }
});

test("diagnostic pruning keeps current sellers case-insensitively and removes departed sellers", () => {
  const keepAt = `stor-${"d".repeat(40)}`, dropAt = `stor-${"e".repeat(40)}`;
  const other = `did:demos:agent:${"f".repeat(64)}`;
  store.recordListingRejection(keepAt, seller, "LISTING_SIGNATURE_INVALID");
  store.recordListingRejection(dropAt, other, "LISTING_SIGNATURE_INVALID");
  store.pruneListingRejections([seller.toUpperCase()]);
  const items = store.indexerDiagnostics().listingRejectionDiagnostics.items;
  assert.ok(items.some((item) => item.locator === keepAt));
  assert.equal(items.some((item) => item.locator === dropAt), false);
  store.clearRegistrationListingRejections(seller);
});

test("missing candidate owners and restored withdrawal sources without bindings are empty", async () => {
  assert.equal(store.isOwnerRevocationCandidate("a".repeat(64), `stor-${"f".repeat(40)}`, `0x${keyHex}`), false);
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(join(dataDirectory, "directory.sqlite"));
  const previous = db.prepare("SELECT value_json FROM kv_state WHERE key='withdrawal-sources'").get() as { value_json: string } | undefined;
  try {
    db.prepare("INSERT OR REPLACE INTO kv_state(key,value_json,updated_at) VALUES ('withdrawal-sources',?,1)")
      .run(JSON.stringify([{ domain: "restored.example", seller, hashes: [], incomplete: [], provenance: "publisher-signature" }]));
    assert.deepEqual(store.boundWellKnownRevocations(seller, "a".repeat(64), "listing", 1), []);
  } finally {
    if (previous) db.prepare("UPDATE kv_state SET value_json=? WHERE key='withdrawal-sources'").run(previous.value_json);
    else db.prepare("DELETE FROM kv_state WHERE key='withdrawal-sources'").run();
    db.close();
  }
});

test("legacy numeric-looking validity strings do not become current-profile numeric windows", async () => {
  const scope = { agentId: seller, serviceId: "legacy-window", name: "Legacy", description: "Historical validity extension",
    claimRequirements: [], supportedNegotiation: ["negotiate-fixed-price"], supportedPaymentRails: ["pay-dem"],
    supportedDelivery: ["deliver-storage-program"], validity: { notBefore: "9007199254740991", notAfter: "1" } };
  const data = { ...scope, signature: Buffer.from(sign(`dacs-listing:v1:${contentHash(scope)}`), "base64url").toString("hex") };
  assert.equal((await verifyListingResult(data)).ok, true);
  const anchor = `stor-${"9".repeat(40)}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ success: true, owner: `0x${keyHex}`, programName: "opaque", data });
  try {
    const record = await indexRegistration({ primaryClaim: seller, displayName: "Legacy", listingAnchors: [anchor] }, undefined, async () => ({}));
    assert.deepEqual(record.listings.map((item) => [item.listingId, item.status]), [["legacy-window", "active"]]);
  } finally { globalThis.fetch = originalFetch; }
});


test("rejections never assign unauthenticated coordinates or blame another seller; latest pointers replace stale diagnostics", async () => {
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
    await indexRegistration({ ...reg, listingAnchors: [] }, undefined, async () => ({}));
    assert.equal(store.indexerDiagnostics().listingRejectionDiagnostics.items.some((item) => item.locator === anchor && item.code !== "SELLER_CLAIM_BINDING"), false);
    await indexRegistration({ ...reg, primaryClaim: other, listingAnchors: [] }, undefined, async () => ({}));
    assert.equal(store.indexerDiagnostics().listingRejectionDiagnostics.items.some((item) => item.locator === anchor), false);
  } finally { globalThis.fetch = originalFetch; }
});


test("only owner-signed, seller-matching pointer failures appear publicly, and a corrected pointer clears them", async () => {
  const anchor = `stor-${"b".repeat(40)}`;
  const data = signedListing("public-pointer", attested({ kind: "self-signed" }));
  const reg: Registration = { primaryClaim: seller, displayName: "Signed seller", listingAnchors: [anchor],
    listingContentHashes: { [anchor]: "0".repeat(64) } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ success: true, owner: `0x${keyHex}`, programName: "opaque", data });
  try {
    await indexRegistration(reg, undefined, async () => ({}));
    assert.equal(store.indexerDiagnostics().listingRejectionDiagnostics.publicTotal, 0);
    const message = registrationMessage(reg, 1);
    reg.ownerSignature = { message, signedAt: 1, signature: sign(message) };
    await indexRegistration(reg, undefined, async () => ({}));
    let diagnostics = store.indexerDiagnostics().listingRejectionDiagnostics;
    assert.equal(diagnostics.publicTotal, 1);
    assert.equal(diagnostics.items.find((item) => item.publicNotice)?.listingId, "public-pointer");
    assert.match(diagnostics.items.find((item) => item.publicNotice)?.guidance ?? "", /declared hash in the discovery channel/);
    reg.listingContentHashes = {};
    assert.equal((await indexRegistration(reg, undefined, async () => ({}))).listings.length, 1);
    diagnostics = store.indexerDiagnostics().listingRejectionDiagnostics;
    assert.equal(diagnostics.publicTotal, 0);
    assert.equal(diagnostics.items.some((item) => item.locator === anchor), false);
  } finally { globalThis.fetch = originalFetch; }
});
