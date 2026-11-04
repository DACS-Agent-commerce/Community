import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, RawJsonAdmissionError } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { storageArtifactResponseJson } from "../src/catalog/artifactLimits.js";
import { readAnchorResult, resolveOwnedAnchorByName } from "../src/catalog/chain.js";
import { readStorage } from "../src/catalog/scan.js";
import { verifyListing } from "../src/catalog/listingVerification.js";

// CORE §B.2 CF-5: storage replies are admitted on their received bytes, before JSON.parse can
// collapse duplicate members or round numbers the signature never covered.
const seed = Uint8Array.from(Buffer.alloc(32, 86));
const did = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const sign = (message: string) => Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKeyFromSeed(seed))).toString("base64url");
const identityScope = { bundleVersion: "1", presentedBy: did, presentedAt: 1, claims: [{ ref: did }] };
const identity = { ...identityScope, presentation: { kind: "per-claim", signatures: [{ ref: did,
  signature: sign(`dacs-bundle-presentation:v1:${contentHash(identityScope)}`) }] } };
const listingScope = {
  dacsVersion: "1", listingVersion: 2, listingId: "svc", requiredCapabilities: ["SR-2"],
  seller: { displayName: "Raw fixture", identity },
  offering: { title: "Raw fixture", description: "Raw fixture", category: "services.other", tags: [],
    deliverable: { kind: "storage-program", accessModel: "public" } },
  buyerRequirement: { requirementVersion: "1", required: [] },
  pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "deliver-storage-program" }],
  pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } }, terms: {}, validity: { notBefore: 1 },
};
const signedListing = { ...listingScope, signature: { algorithm: "ed25519", signer: did,
  value: sign(`dacs-listing:v1:${contentHash(listingScope)}`) } };
const locator = `stor-${"c".repeat(40)}`;

const replyText = (listingText: string) =>
  `{"success":true,"programName":"raw-fixture","owner":"0x${did.slice(-64)}","data":${listingText}}`;
const canonicalListingText = JSON.stringify(signedListing);
const duplicateMemberListingText = canonicalListingText.replace('"listingId":"svc"', '"listingId":"svc","listingId":"svc"');
const unsafeIntegerListingText = canonicalListingText.replace('"listingVersion":2', '"listingVersion":9007199254740993');
const overflowListingText = canonicalListingText.replace('"listingVersion":2', '"listingVersion":1e999');
const equivalentSpellingListingText = canonicalListingText.replace('"listingVersion":2', '"listingVersion":2.0e0');

async function withStorageReply<T>(text: string | Uint8Array, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(text as BodyInit);
  try { return await run(); } finally { globalThis.fetch = original; }
}
const refusalOf = async (text: string) => (await storageArtifactResponseJson(new Response(text))).refusal;

test("fixture: the signed Listing with a duplicate member is the signed Listing once the duplicate is dropped", async () => {
  assert.notEqual(duplicateMemberListingText, canonicalListingText);
  assert.deepEqual(JSON.parse(duplicateMemberListingText), signedListing, "JSON.parse alone would admit it silently");
  assert.ok(await verifyListing(JSON.parse(duplicateMemberListingText)), "and the signature covers the parsed value");
});

test("a canonical Listing reply is still admitted", async () => {
  const read = await withStorageReply(replyText(canonicalListingText), () => readStorage(locator, 1));
  assert.equal(read.success, true);
  assert.deepEqual(read.data, signedListing);
  assert.equal(await refusalOf(replyText(canonicalListingText)), undefined);
});

test("a Listing reply with a duplicate member is refused and its data withheld", async () => {
  const read = await withStorageReply(replyText(duplicateMemberListingText), () => readStorage(locator, 1));
  assert.equal(read.data, undefined);
  assert.equal(read.admissionRefusal, "DUPLICATE-MEMBER");
});

test("a Listing reply with an unsafe integer is refused and its data withheld", async () => {
  const read = await withStorageReply(replyText(unsafeIntegerListingText), () => readStorage(locator, 1));
  assert.equal(read.data, undefined);
  assert.equal(read.admissionRefusal, "NUMBER-OUTSIDE-DACS-MAGNITUDE");
});

test("a reply member named admissionRefusal is not read as a refusal", async () => {
  const injected = (text: string) => text.replace('"success":true', '"success":true,"admissionRefusal":"INJECTED"');
  const clean = await withStorageReply(injected(replyText(canonicalListingText)), () => readStorage(locator, 1));
  assert.equal(clean.success, true);
  assert.equal(clean.admissionRefusal, undefined);
  assert.deepEqual(clean.data, signedListing);
  const refused = await withStorageReply(injected(replyText(duplicateMemberListingText)), () => readStorage(locator, 1));
  assert.equal(refused.data, undefined);
  assert.equal(refused.admissionRefusal, "DUPLICATE-MEMBER");
});

test("the refusal keeps its stage and code", async () => {
  for (const [text, code] of [
    [replyText(duplicateMemberListingText), "DUPLICATE-MEMBER"],
    [replyText(unsafeIntegerListingText), "NUMBER-OUTSIDE-DACS-MAGNITUDE"],
    [replyText(overflowListingText), "NUMBER-NOT-BINARY64"],
    ['{"a":"\\ud800"}', "INVALID-UNICODE"],
  ]) {
    const refusal = await refusalOf(text);
    assert.ok(refusal instanceof RawJsonAdmissionError, code);
    assert.equal(refusal.stage, "profile");
    assert.equal(refusal.code, code);
  }
});

test("a spelling the CF-5 number profile admits, such as 2.0e0, is still read as its value", async () => {
  const { reply, refusal } = await storageArtifactResponseJson(new Response(replyText(equivalentSpellingListingText)));
  assert.equal(refusal, undefined);
  assert.equal((reply as { data: { listingVersion: number } }).data.listingVersion, 2);
});

test("a reply that is not JSON stays a SyntaxError and keeps the admission error as its cause", async () => {
  await assert.rejects(storageArtifactResponseJson(new Response('{"success":')), (error: unknown) =>
    error instanceof SyntaxError && error.cause instanceof RawJsonAdmissionError && error.cause.code === "INVALID-JSON");
});

test("an anchor read names a raw-admission refusal as its reason", async () => {
  const read = await withStorageReply(replyText(duplicateMemberListingText), () => readAnchorResult(locator));
  assert.deepEqual(read, { status: "unavailable", reason: "storage reply refused by raw JSON admission: DUPLICATE-MEMBER" });
});

// Documents today's behaviour: invalid UTF-8 and a byte-order mark are refused at the parse stage, so
// they surface as a SyntaxError (an unreadable reply), not as the profile-stage refusal that is recorded.
const canonicalReply = replyText(canonicalListingText);
const splitAt = canonicalReply.indexOf("raw-fixture") + 3;
const parseStageReplies: Array<[string, Buffer, string]> = [
  ["invalid UTF-8", Buffer.concat([Buffer.from(canonicalReply.slice(0, splitAt)), Buffer.from([0xff]), Buffer.from(canonicalReply.slice(splitAt))]), "INVALID-UTF8"],
  ["a byte-order mark", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonicalReply)]), "BOM"],
];
for (const [name, bytes, code] of parseStageReplies) {
  test(`documents current behaviour: ${name} in a storage reply is a parse-stage SyntaxError, unreadable to a scan and invalid JSON to an anchor read`, async () => {
    await assert.rejects(storageArtifactResponseJson(new Response(bytes as BodyInit)), (error: unknown) => error instanceof SyntaxError &&
      error.cause instanceof RawJsonAdmissionError && error.cause.stage === "parse" && error.cause.code === code);
    const read = await withStorageReply(bytes, () => readStorage(locator, 1));
    assert.deepEqual(read, { success: false, failureCode: "STORAGE_INVALID_RESPONSE" }, "no data admitted, no admission refusal recorded");
    const anchor = await withStorageReply(bytes, () => readAnchorResult(locator));
    assert.deepEqual(anchor, { status: "unavailable", reason: "anchor reply is invalid JSON" });
  });
}

test("a program-name lookup does not resolve an anchor from a refused reply and stays indeterminate", async () => {
  const owner = `0x${did.slice(-64)}`;
  const original = globalThis.fetch;
  const reply = (text: string) => async (_input: unknown, init?: RequestInit) => init?.method === "POST"
    ? Response.json({ result: 200, response: [{ storageAddress: locator, programName: "raw-fixture" }] })
    : new Response(text);
  try {
    globalThis.fetch = reply(canonicalReply) as typeof fetch;
    const control = await resolveOwnedAnchorByName("raw-fixture", owner);
    assert.equal(control.status, "present", "the same reply without the duplicate member resolves");
    globalThis.fetch = reply(replyText(duplicateMemberListingText)) as typeof fetch;
    assert.deepEqual(await resolveOwnedAnchorByName("raw-fixture", owner),
      { status: "indeterminate", reason: "a candidate returned invalid storage metadata" });
  } finally { globalThis.fetch = original; }
});
