import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NextRequest } from "next/server";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { GET as wellknownFiles } from "../app/api/dacs/wellknown-files/route.js";
import { indexRegistration } from "../src/catalog/indexer.js";
import { verifyListing } from "../src/catalog/listingVerification.js";
import { crawlDomain } from "../src/catalog/wellknown.js";
import * as store from "../src/catalog/store.js";

type Obj = Record<string, unknown>;
const seed = Buffer.alloc(32, 0x62);
const secondarySeed = Buffer.alloc(32, 0x63);
const did = (key: Uint8Array) => `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(key))).toString("hex")}`;
const seller = did(seed);
const owner = `0x${seller.slice(-64)}`;
const locator = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;
const sign = (message: string, key = seed) => Buffer.from(ed25519Sign(Buffer.from(message), privateKeyFromSeed(key))).toString("base64url");

function currentListing(listingId: string, signerSeed = seed): Obj {
  const identity: Obj = { bundleVersion: "1", presentedBy: seller, presentedAt: 1,
    claims: [{ ref: seller }, ...(signerSeed === seed ? [] : [{ ref: did(signerSeed) }])] };
  identity.presentation = { kind: "per-claim", signatures: [{ ref: seller,
    signature: sign(`dacs-bundle-presentation:v1:${contentHash(identity)}`) }] };
  const scope = {
    dacsVersion: "1", listingVersion: 1, listingId, seller: { identity, displayName: "Seller" },
    offering: { title: listingId, description: "test", category: "services.test", tags: [], deliverable: { kind: "storage-program" } },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "deliver-storage-program" }],
    pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } }, terms: {}, validity: { notBefore: 1 },
  };
  return { ...scope, signature: { algorithm: "ed25519", signer: did(signerSeed),
    value: sign(`dacs-listing:v1:${contentHash(scope)}`, signerSeed) } };
}

const offline = async () => ({});
const requestFiles = () => wellknownFiles(new NextRequest(
  `https://directory.example/api/dacs/wellknown-files?claim=${encodeURIComponent(seller)}&domain=1.1.1.1`,
));

test("signed zero revokedAt withdraws a Listing and remains revoked on the next pass", async (t) => {
  const raw = currentListing("zero-withdrawal");
  const verified = await verifyListing(raw);
  assert.ok(verified);
  const markerScope = { listingId: "zero-withdrawal", listingVersion: 1,
    listingContentHash: verified.contentHash, revokedAt: 0 };
  const marker = { ...markerScope, signature: { algorithm: "ed25519", signer: seller,
    value: sign(`dacs-revocation:v1:${contentHash(markerScope)}`) } };
  const [listingAt, markerAt] = [locator(1001), locator(1002)];
  store.admitRevocationCandidates(verified.contentHash, [{ locator: markerAt, owner }]);
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => Response.json({ success: true, owner,
    data: String(input).endsWith(listingAt) ? raw : marker }));
  const registration = { primaryClaim: seller, displayName: "Seller", listingAnchors: [listingAt] };
  const first = await indexRegistration(registration, undefined, offline);
  assert.equal(first.listings[0]?.status, "revoked");
  assert.equal(first.listings[0]?.revocation?.markerContentHash, contentHash(markerScope));
  const second = await indexRegistration(registration, first, offline);
  assert.equal(second.listings[0]?.status, "revoked");
});

test("generated discovery round-trips the authenticated legacy NFC member-name hash", async (t) => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/reviewbot-listing-anchor.json", import.meta.url), "utf8"));
  const { signature: _, ...original } = fixture.data;
  const scope = { ...original, agentId: seller, metadata: { ["e\u0301"]: "bound" } };
  // Independent SDK 44d8ff2 preimage: normalize member names before sorting.
  const hash = contentHash({ ...scope, metadata: { "é": "bound" } });
  const raw = { ...scope, signature: sign(`dacs-listing:v1:${hash}`) };
  const anchor = locator(1010);
  t.mock.method(globalThis, "fetch", async () => Response.json({ success: true, owner, data: raw }));
  const registration = { primaryClaim: seller, displayName: "Seller", listingAnchors: [anchor] };
  const record = await indexRegistration(registration, undefined, offline);
  assert.equal(record.listings[0]?.contentHash, hash);
  store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [record] });
  const response = await requestFiles();
  assert.equal(response.status, 200);
  const { files } = await response.json();
  const index = JSON.parse(files["/.well-known/dacs/listings.json"]);
  assert.equal(index.listings[0]?.contentHash, hash);
  const crawled = await crawlDomain("1.1.1.1", { fetchJson: async (url) => {
    const raw = files[new URL(url).pathname];
    return raw ? { body: JSON.parse(raw), raw } : null;
  } });
  assert.ok(!("error" in crawled), JSON.stringify(crawled));
  assert.deepEqual(crawled.activeListingAnchors, [anchor]);
  const reingested = await indexRegistration({ ...registration, listingContentHashes: crawled.contentHashes }, undefined, offline);
  assert.equal(reingested.listings[0]?.contentHash, hash);
});

test("discovery rechecks changed bytes and accepts a Listing signed by a second seller claim", async (t) => {
  let raw = currentListing("secondary-signer", secondarySeed);
  const anchor = locator(1020);
  t.mock.method(globalThis, "fetch", async () => Response.json({ success: true, owner, data: raw }));
  const record = await indexRegistration({ primaryClaim: seller, displayName: "Seller", listingAnchors: [anchor] }, undefined, offline);
  assert.equal(record.listings.length, 1);
  store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [record] });
  const valid = await (await requestFiles()).json();
  assert.equal(JSON.parse(valid.files["/.well-known/dacs/listings.json"]).listings[0]?.contentHash,
    (await verifyListing(raw))?.contentHash);
  raw = { ...raw, terms: { refundPolicy: "changed after signing" } };
  const changed = await (await requestFiles()).json();
  assert.deepEqual(JSON.parse(changed.files["/.well-known/dacs/listings.json"]).listings, []);
});

test("continuing listing rejections retain firstSeenAt and occurrences while stale rows are pruned", async (t) => {
  const [anchor, removed] = [locator(1030), locator(1031)];
  const otherOwner = `0x${"f".repeat(64)}`;
  const raw = currentListing("repeated-owner-mismatch");
  let currentOwner = otherOwner;
  let available = true;
  t.mock.method(globalThis, "fetch", async () => available
    ? Response.json({ success: true, owner: currentOwner, data: raw })
    : new Response(null, { status: 503 }));
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  const registration = { primaryClaim: seller, displayName: "Seller", listingAnchors: [anchor, removed] };
  await indexRegistration(registration, undefined, offline);
  const diagnostic = () => store.indexerDiagnostics({ deadLetterLocator: anchor }).listingRejectionDiagnostics.items[0];
  assert.equal(diagnostic()?.firstSeenAt, 1_000);
  assert.equal(diagnostic()?.occurrences, 1);
  now = 2_000;
  registration.listingAnchors = [anchor];
  await indexRegistration(registration, undefined, offline);
  assert.equal(diagnostic()?.firstSeenAt, 1_000);
  assert.equal(diagnostic()?.lastSeenAt, 2_000);
  assert.equal(diagnostic()?.occurrences, 2);
  assert.deepEqual(store.indexerDiagnostics({ deadLetterLocator: removed }).listingRejectionDiagnostics.items, []);
  // An unavailable read cannot reassert a public rejection from stale bytes.
  available = false;
  await indexRegistration(registration, undefined, offline);
  assert.equal(diagnostic(), undefined);
  available = true;
  await indexRegistration(registration, undefined, offline);
  currentOwner = owner;
  assert.equal((await indexRegistration(registration, undefined, offline)).listings.length, 1);
  assert.equal(diagnostic(), undefined);
  currentOwner = otherOwner;
  await indexRegistration(registration, undefined, offline);
  await indexRegistration({ ...registration, listingAnchors: [] }, undefined, offline);
  assert.equal(diagnostic(), undefined);
});
