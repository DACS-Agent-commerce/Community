import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { contentHash, canonicalize, stripSignature } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, ed25519Verify, privateKeyFromSeed, publicKeyFromSeed, publicKeyFromRaw, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { isListing } from "@kynesyslabs/dacs/artifacts";
import { verifyBundleCore } from "../src/sdkVerification.js";
import { legacyListingHash } from "../src/catalog/legacyListingHash.js";
import { verifyListing } from "../src/catalog/listingVerification.js";
import { refsPassStrictPolicy, verifiedListingTerms } from "../src/catalog/bundlePolicy.js";

type Obj = Record<string, unknown>;
const seeds = [41, 42].map(byte => Uint8Array.from(Buffer.alloc(32, byte)));
const keys = seeds.map(seed => rawPublicKey(publicKeyFromSeed(seed)));
const claims = keys.map(key => `did:demos:agent:${Buffer.from(key).toString("hex")}`);
const sign = (scope: Obj, prefix: string, index = 1, encoding: BufferEncoding = "base64url") =>
  Buffer.from(ed25519Sign(Buffer.from(prefix + legacyListingHash(scope)), privateKeyFromSeed(seeds[index]))).toString(encoding);
const partySignature = (scope: Obj, prefix: string, index: number) =>
  ({ party: claims[index], algorithm: "ed25519", value: sign(scope, prefix, index) });

function fixture(signatureKind: string, unicode = false) {
  const listingScope: Obj = { agentId: claims[1], serviceId: "svc", name: "Service", description: "Legacy service", claimRequirements: [],
    supportedNegotiation: ["negotiate-fixed-price"], supportedPaymentRails: ["pay-dem"], supportedDelivery: ["deliver-attested-payload"],
    terms: { cancellationPolicy: "pre-commit" }, ...(unicode ? { "e\u0301": "historical member" } : {}) };
  const value = sign(listingScope, "dacs-listing:v1:", 1, signatureKind === "base64url" ? "base64url" : "hex");
  const listing: Obj = { ...listingScope, signature: signatureKind === "structured"
    ? { algorithm: "ed25519", signer: claims[1], value } : signatureKind === "0x" ? `0x${value}` : value };
  const agreementScope: Obj = { jobId: "legacy", pattern: "fixed-price", buyer: claims[0], seller: claims[1], listingRef: "listing",
    price: { amount: "1", asset: "DEM", decimals: 18, rail: "pay-dem" }, delivery: { phase: "deliver-attested-payload", format: "application/json" },
    expiresAt: "2099-01-01T00:00:00.000Z", ...(unicode ? { "e\u0301": "agreement member" } : {}) };
  const agreement = { ...agreementScope, signatures: [0, 1].map(index => partySignature(agreementScope, "dacs-agreement:v1:", index)) };
  const body: Obj = { bundleVersion: "1", jobId: "legacy", outcome: "completed",
    listingRef: { listingId: "svc", version: 1, contentHash: legacyListingHash(listingScope) },
    agreementRef: { kind: "dacs-3-agreement", id: "agreement", contentHash: legacyListingHash(agreementScope) },
    parties: claims.map((primaryClaim, i) => ({ role: i ? "seller" : "buyer", primaryClaim, bundleHash: "a".repeat(64) })),
    phaseSummary: [{ index: 0, kind: "commit-agreement", outcome: "ok" }], vetRecords: [], settlementEvidence: [],
    recipeRegistryVersion: 1, railRegistryVersion: 1, finalisedAt: 1_700_000_000_000,
    ...(unicode ? { "e\u0301": "bundle member" } : {}) };
  const bundle = { ...body, anchoredByRole: "seller", signatures: [0, 1].map(index => partySignature(body, "dacs-bundle:v1:", index)) };
  return { bundle, listing, agreement };
}

async function verify(f: ReturnType<typeof fixture>) {
  const artifacts = [{ kind: "dacs-3-agreement", raw: f.agreement }, { kind: "dacs-1-listing", raw: f.listing }];
  const result = await verifyBundleCore("bundle", {
    readArtifact: async ref => ref === "bundle" ? f.bundle : ref === "listing" ? f.listing : null,
    resolveRef: async kind => kind === "dacs-3-agreement" ? f.agreement : f.listing,
    resolvePublicKey: async claim => { const index = claims.indexOf(claim); return index >= 0 ? keys[index] : null; },
    verify: (message, signature, key) => ed25519Verify(message, signature, publicKeyFromRaw(key)),
  });
  return { result, artifacts, strict: await refsPassStrictPolicy(result, artifacts) };
}

test("legacy bundle verification accepts all historical Listing signature spellings", async () => {
  for (const spelling of ["hex", "base64url", "0x", "structured"]) {
    const f = fixture(spelling);
    assert.ok(await verifyListing(f.listing), spelling);
    const checked = await verify(f);
    assert.equal(checked.result.ok, true, `${spelling}: ${JSON.stringify(checked.result.refs)}`);
    assert.equal(checked.strict, true, spelling);
    f.listing.name = "tampered";
    assert.equal((await verify(f)).strict, false, `${spelling}: changed signed content`);
  }
});

test("legacy hashes agree across Listing admission, bundle roots, references and terms", async () => {
  const f = fixture("structured", true);
  const hash = legacyListingHash(stripSignature(f.listing));
  assert.notEqual(hash, contentHash(f.listing));
  assert.equal((await verifyListing(f.listing))?.contentHash, hash);
  const checked = await verify(f);
  assert.equal(checked.result.ok, true, JSON.stringify(checked.result));
  assert.equal(checked.strict, true);
  assert.deepEqual(verifiedListingTerms(checked.result, checked.artifacts, checked.strict), { cancellationPolicy: "pre-commit" });
  f.listing["e\u0301"] = "modified";
  assert.equal((await verify(f)).strict, false);
});

test("LR-2 measures canonical bytes without the Listing signature", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/listing-public-storage.json", import.meta.url), "utf8")).listing;
  const scope = { ...stripSignature(fixture), padding: "" };
  const size = Buffer.byteLength(canonicalize(scope));
  for (const bytes of [16_384, 16_385]) {
    const raw = { ...scope, padding: "x".repeat(bytes - size), signature: fixture.signature };
    assert.equal(Buffer.byteLength(canonicalize(stripSignature(raw))), bytes);
    assert.equal(isListing(raw), bytes === 16_384);
  }
});

test("strict references independently bind each expected hash after successful verification", async () => {
  const checked = await verify(fixture("structured", true));
  assert.equal(checked.result.ok, true);
  assert.ok(checked.result.refs.every(ref => ref.verdict === "ok"));
  assert.equal(checked.strict, true);
  for (const field of ["agreementRef", "listingRef"] as const) {
    const result = structuredClone(checked.result);
    result.bundle![field]!.contentHash = "0".repeat(64);
    assert.deepEqual(result.refs, checked.result.refs, "SDK reference verdicts stay successful");
    assert.equal(await refsPassStrictPolicy(result, checked.artifacts), false, field);
  }
});

test("Listing terms independently require the exact reference ID and version with hash fixed", async () => {
  const historical = await verify(fixture("structured", true));
  const current: Obj = { dacsVersion: "1", listingId: "current-svc", listingVersion: 2,
    terms: { cancellationPolicy: "pre-commit" } };
  for (const [verification, artifacts] of [
    [historical.result, historical.artifacts],
    [{ bundle: { listingRef: { listingId: "current-svc", version: 2, contentHash: contentHash(current) } } },
      [{ kind: "dacs-1-listing", raw: current }]],
  ] as Array<[Parameters<typeof verifiedListingTerms>[0], Parameters<typeof verifiedListingTerms>[1]]>) {
    assert.deepEqual(verifiedListingTerms(verification, artifacts, true), { cancellationPolicy: "pre-commit" });
    for (const field of ["listingId", "version"] as const) {
      const changed = structuredClone(verification);
      if (field === "version") changed!.bundle!.listingRef.version++;
      else changed!.bundle!.listingRef.listingId += "-other";
      assert.equal(verifiedListingTerms(changed, artifacts, true), undefined, field);
    }
  }
});


test("a current Listing referenced by a historical bundle retains its current hash profile", () => {
  const listing: Obj = { dacsVersion: "1", listingId: "current-svc", listingVersion: 1,
    "e\u0301": "current member", terms: { cancellationPolicy: "pre-commit" } };
  const hash = contentHash(listing);
  assert.notEqual(hash, legacyListingHash(listing));
  const verification = { bundle: { listingRef: { listingId: "current-svc", version: 1, contentHash: hash } } } as unknown as Parameters<typeof verifiedListingTerms>[0];
  const artifacts = [{ kind: "dacs-1-listing", raw: listing }];
  assert.deepEqual(verifiedListingTerms(verification, artifacts, true), listing.terms);
  listing["e\u0301"] = "modified";
  assert.equal(verifiedListingTerms(verification, artifacts, true), undefined);
});


test("a historical agreement with dacsVersion keeps its historical hash profile", async () => {
  const f = fixture("structured", true);
  const scope = { ...stripSignature(f.agreement), dacsVersion: "1" };
  f.agreement = { ...scope, signatures: [0, 1].map(index => partySignature(scope, "dacs-agreement:v1:", index)) } as typeof f.agreement;
  const historicalHash = legacyListingHash(scope);
  const currentHash = contentHash(f.agreement);
  assert.notEqual(historicalHash, currentHash, "decomposed member names distinguish the profiles");
  ((f.bundle as Obj).agreementRef as { contentHash: string }).contentHash = historicalHash;
  const { anchoredByRole: _role, ...bundleScope } = stripSignature(f.bundle);
  f.bundle.signatures = [0, 1].map(index => partySignature(bundleScope, "dacs-bundle:v1:", index));
  const checked = await verify(f);
  assert.equal(checked.result.ok, true, JSON.stringify(checked.result));
  assert.ok(checked.result.refs.every(ref => ref.verdict === "ok"));
  assert.equal(checked.strict, true, "an additive extension cannot change a historical agreement's profile");
  const substituted = structuredClone(checked.result);
  substituted.bundle!.agreementRef!.contentHash = currentHash;
  assert.equal(await refsPassStrictPolicy(substituted, checked.artifacts), false,
    "successful SDK verdicts cannot authorize a substituted current-profile hash");
});
