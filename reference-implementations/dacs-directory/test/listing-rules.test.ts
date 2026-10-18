import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";

// DACS-1 listing validation (§6.3.4 steps 1-3, LR-2) and the indexer's publication gate, one case per
// rule. Every case is signed again, so only the rule under test can reject it.
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-listing-rules-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
const { verifyListing } = await import("../src/catalog/listingVerification.js");
const { indexRegistration } = await import("../src/catalog/indexer.js");
test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));

type Obj = Record<string, unknown>;
const seeds = [61, 62].map((byte) => Uint8Array.from(Buffer.alloc(32, byte)));
const keys = seeds.map((seed) => Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex"));
const dids = keys.map((key) => `did:demos:agent:${key}`);
const sign = (message: string, signer = 0, encoding: BufferEncoding = "base64url") =>
  Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKeyFromSeed(seeds[signer]))).toString(encoding);
const tail = [{ kind: "commit-agreement" }, { kind: "pay-dem", parameters: { rail: "pay-dem" } }, { kind: "deliver-attested-payload" }];
const RFQ = { maxTurns: 6, timeoutSec: 300 };
const SEALED = { commitDeadline: 1784016000000, revealWindow: 3600, selectionRule: "lowest-price" };
const negotiable = { kind: "negotiable", bandCenter: { amount: "1", currency: "DEM" }, minPct: 10, maxPct: 10 };
const auction = { kind: "auction", selectionRule: "lowest-price" };

function identityFor(claim: string, presentation: (identity: Obj) => Obj | undefined) {
  const identity: Obj = { bundleVersion: "1", presentedBy: claim, presentedAt: 1, claims: [{ ref: claim }] };
  const value = presentation(identity);
  return value === undefined ? identity : { ...identity, presentation: value };
}
const perClaim = (identity: Obj, signer = 0, encoding: BufferEncoding = "hex") =>
  ({ kind: "per-claim", signatures: [{ ref: identity.presentedBy, signature: sign(`dacs-bundle-presentation:v1:${contentHash(identity)}`, signer, encoding) }] });

/** A valid current listing, edited by `change` before it is signed by `signer`. */
function listing(change: (scope: Obj) => void = () => {}, options: { signer?: number; envelope?: Obj | null; presentation?: (identity: Obj) => Obj | undefined } = {}): Obj {
  const scope: Obj = {
    dacsVersion: "1", listingVersion: 1, listingId: "rules-listing", requiredCapabilities: ["SR-2"],
    seller: { displayName: "Rules desk", identity: identityFor(dids[0], options.presentation ?? ((identity) => perClaim(identity))) },
    offering: { title: "Rules", description: "Listing rules", category: "rules.test", tags: ["rules"], deliverable: { kind: "attested-payload", payloadFormat: "application/json" } },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [{ kind: "negotiate-fixed-price" }, ...tail],
    pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } },
    acceptedRails: [{ railId: "pay-dem" }], terms: {}, validity: { notBefore: 1 },
  };
  change(scope);
  if (options.envelope === null) return scope;
  const signer = options.signer ?? 0;
  return { ...scope, signature: { algorithm: "ed25519", signer: dids[signer], value: sign(`dacs-listing:v1:${contentHash(scope)}`, signer), ...options.envelope } };
}
const at = (scope: Obj, path: string) => path.split(".").reduce<Obj>((node, key) => node[key] as Obj, scope);
const set = (path: string, value: unknown) => (scope: Obj) => {
  const keys = path.split("."); const last = keys.pop()!;
  const node = keys.length ? at(scope, keys.join(".")) : scope;
  if (value === undefined) delete node[last]; else node[last] = value;
};
const pricedWith = (pricing: Obj, negotiation: Obj) => (scope: Obj) => { scope.pricing = pricing; scope.pipeline = [negotiation, ...tail]; };
const step = (step: Obj, pricing: Obj = scope0Pricing) => (scope: Obj) => { scope.pricing = pricing; scope.pipeline = [step, ...tail]; };
const scope0Pricing = { kind: "fixed", price: { amount: "1", currency: "DEM" } };

async function verdicts(cases: Record<string, (scope: Obj) => void>): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const [name, change] of Object.entries(cases)) out[name] = (await verifyListing(listing(change))) !== null;
  return out;
}
const all = (names: Record<string, unknown>, value: boolean) => Object.fromEntries(Object.keys(names).map((name) => [name, value]));

test("DACS-1 §6.3.2: identity, offering, pricing, pipeline and validity rules accept their boundaries", async () => {
  const accepted: Record<string, (scope: Obj) => void> = {
    "the base listing": () => {},
    "a 128-character listingId of every allowed character": set("listingId", "aZ09._~-".repeat(16)),
    "a 200-character displayName": set("seller.displayName", "d".repeat(200)),
    "a public HTTPS endpoint": set("seller.publicEndpoint", "https://agent.example/a2a"),
    "a 200-character title": set("offering.title", "t".repeat(200)),
    "a 2,000-character description": set("offering.description", "d".repeat(2000)),
    "a 64-character category": set("offering.category", "c".repeat(64)),
    "16 tags of 32 characters": set("offering.tags", Array.from({ length: 16 }, () => "t".repeat(32))),
    "negotiable pricing at 0% and 99%": pricedWith({ ...negotiable, minPct: 99, maxPct: 0 }, { kind: "negotiate-rfq", parameters: RFQ }),
    "an amount below one": set("pricing.price", { amount: "0.5", currency: "DEM" }),
    "a 64-character currency and unit": set("pricing.price", { amount: "1", currency: "c".repeat(64), unit: "u".repeat(64) }),
    "metered pricing with a minimum total in its currency": pricedWith({ kind: "metered", unitPrice: { amount: "1", currency: "DEM" }, unit: "u".repeat(64), minTotal: { amount: "2", currency: "DEM" } }, { kind: "negotiate-fixed-price" }),
    "an auction with a reserve price": pricedWith({ ...auction, reservePrice: { amount: "2", currency: "DEM" } }, { kind: "negotiate-sealed-envelope", parameters: SEALED }),
    "an intake-only pipeline without rails": (scope) => { scope.pipeline = [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "deliver-attested-payload" }]; delete scope.acceptedRails; },
    "a vet phase before negotiation": (scope) => { scope.pipeline = [{ kind: "vet-credentials" }, { kind: "negotiate-fixed-price" }, ...tail]; },
    "notAfter equal to notBefore": set("validity", { notBefore: 5, notAfter: 5 }),
  };
  const rejected: Record<string, (scope: Obj) => void> = {
    "dacsVersion 2": set("dacsVersion", "2"),
    "listingVersion 0": set("listingVersion", 0),
    "listingVersion as a string": set("listingVersion", "1"),
    "an empty listingId": set("listingId", ""),
    "a 129-character listingId": set("listingId", "a".repeat(129)),
    "a listingId with a space": set("listingId", "rules listing"),
    "a listingId that is not a string": set("listingId", 7),
    "a 201-character displayName": set("seller.displayName", "d".repeat(201)),
    "no displayName": set("seller.displayName", undefined),
    "a loopback endpoint": set("seller.publicEndpoint", "http://localhost/a2a"),
    "no presentedBy": set("seller.identity.presentedBy", undefined),
    "no claims": set("seller.identity.claims", []),
    "claims without the publisher": set("seller.identity.claims", [{ ref: dids[1] }]),
    "a claim ref that is not a string": set("seller.identity.claims", [{ ref: 7 }]),
    "a 201-character title": set("offering.title", "t".repeat(201)),
    "no title": set("offering.title", undefined),
    "a 2,001-character description": set("offering.description", "d".repeat(2001)),
    "no description": set("offering.description", undefined),
    "an uppercase category": set("offering.category", "Rules.Test"),
    "a 65-character category": set("offering.category", "c".repeat(65)),
    "no category": set("offering.category", undefined),
    "17 tags": set("offering.tags", Array.from({ length: 17 }, (_, n) => `t${n}`)),
    "a 33-character tag": set("offering.tags", ["t".repeat(33)]),
    "a tag that is not a string": set("offering.tags", [7]),
    "an empty pipeline": set("pipeline", []),
    "an unknown phase kind": (scope) => { scope.pipeline = [{ kind: "negotiate-fixed-price" }, ...tail, { kind: "deliver-by-post" }]; },
    "a phase kind that is not a string": (scope) => { scope.pipeline = [{ kind: "negotiate-fixed-price" }, ...tail, { kind: 7 }]; },
    "two negotiation steps": (scope) => { scope.pipeline = [{ kind: "negotiate-fixed-price" }, { kind: "negotiate-fixed-price" }, ...tail]; },
    "a commitment that does not follow negotiation": (scope) => { scope.pipeline = [{ kind: "negotiate-fixed-price" }, { kind: "pay-dem", parameters: { rail: "pay-dem" } }, { kind: "commit-agreement" }]; },
    "two commitment steps": (scope) => { scope.pipeline = [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "commit-payee-bound-agreement" }]; },
    "no negotiation step": (scope) => { scope.pipeline = [...tail]; },
    "a negative minPct": pricedWith({ ...negotiable, minPct: -1 }, { kind: "negotiate-rfq", parameters: RFQ }),
    "a minPct of 100": pricedWith({ ...negotiable, minPct: 100 }, { kind: "negotiate-rfq", parameters: RFQ }),
    "minPct as a string": pricedWith({ ...negotiable, minPct: "10" }, { kind: "negotiate-rfq", parameters: RFQ }),
    "a negative maxPct": pricedWith({ ...negotiable, maxPct: -1 }, { kind: "negotiate-rfq", parameters: RFQ }),
    "no maxPct": pricedWith({ ...negotiable, maxPct: undefined }, { kind: "negotiate-rfq", parameters: RFQ }),
    "a band centre of zero": pricedWith({ ...negotiable, bandCenter: { amount: "0", currency: "DEM" } }, { kind: "negotiate-rfq", parameters: RFQ }),
    "an unknown pricing kind": set("pricing", { kind: "subscription", price: { amount: "1", currency: "DEM" } }),
    "an auction reserve price of zero": pricedWith({ ...auction, reservePrice: { amount: "0", currency: "DEM" } }, { kind: "negotiate-sealed-envelope", parameters: SEALED }),
    "a metered unit that is empty": pricedWith({ kind: "metered", unitPrice: { amount: "1", currency: "DEM" }, unit: "" }, { kind: "negotiate-fixed-price" }),
    "a 65-character metered unit": pricedWith({ kind: "metered", unitPrice: { amount: "1", currency: "DEM" }, unit: "u".repeat(65) }, { kind: "negotiate-fixed-price" }),
    "a metered unit that is not a string": pricedWith({ kind: "metered", unitPrice: { amount: "1", currency: "DEM" }, unit: 7 }, { kind: "negotiate-fixed-price" }),
    "a metered unit price of zero": pricedWith({ kind: "metered", unitPrice: { amount: "0", currency: "DEM" }, unit: "call" }, { kind: "negotiate-fixed-price" }),
    "a malformed minimum total": pricedWith({ kind: "metered", unitPrice: { amount: "1", currency: "DEM" }, unit: "call", minTotal: { amount: "two", currency: "DEM" } }, { kind: "negotiate-fixed-price" }),
    "a minimum total in another currency": pricedWith({ kind: "metered", unitPrice: { amount: "1", currency: "DEM" }, unit: "call", minTotal: { amount: "2", currency: "USD" } }, { kind: "negotiate-fixed-price" }),
    "an amount with a leading zero": set("pricing.price", { amount: "01", currency: "DEM" }),
    "an amount with a trailing zero": set("pricing.price", { amount: "1.50", currency: "DEM" }),
    "an amount of zero": set("pricing.price", { amount: "0", currency: "DEM" }),
    "an amount with an exponent": set("pricing.price", { amount: "1e3", currency: "DEM" }),
    "an amount that is a number": set("pricing.price", { amount: 1, currency: "DEM" }),
    "an empty currency": set("pricing.price", { amount: "1", currency: "" }),
    "a 65-character currency": set("pricing.price", { amount: "1", currency: "c".repeat(65) }),
    "an empty price unit": set("pricing.price", { amount: "1", currency: "DEM", unit: "" }),
    "a 65-character price unit": set("pricing.price", { amount: "1", currency: "DEM", unit: "u".repeat(65) }),
    "a price unit that is not a string": set("pricing.price", { amount: "1", currency: "DEM", unit: 7 }),
    "a pay phase without accepted rails": set("acceptedRails", []),
    "a pay phase on a rail the listing does not accept": set("acceptedRails", [{ railId: "pay-x402" }]),
    "a pay phase whose rail is not a string": (scope) => { scope.pipeline = [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "pay-dem", parameters: { rail: 7 } }]; },
    "no notBefore": set("validity", {}),
    "notBefore as a string": set("validity", { notBefore: "1" }),
    "notAfter before notBefore": set("validity", { notBefore: 5, notAfter: 4 }),
  };
  assert.deepEqual(await verdicts(accepted), all(accepted, true));
  assert.deepEqual(await verdicts(rejected), all(rejected, false));
  // The envelope: no signature, another algorithm, or a signer outside the publisher's claims.
  assert.equal(await verifyListing(listing(undefined, { envelope: null })), null);
  assert.equal(await verifyListing(listing(undefined, { envelope: { algorithm: "ecdsa-secp256k1" } })), null);
  assert.equal(await verifyListing(listing(undefined, { signer: 1 })), null);
  assert.equal(await verifyListing({ ...listing(), signatures: [] }), null);
});

test("DACS-1 validation step 1: schema boundaries of the recognised members", async () => {
  const rfq = (parameters: Obj) => step({ kind: "negotiate-rfq", parameters: { ...RFQ, ...parameters } }, negotiable);
  const sealed = (parameters: Obj, kind = "negotiate-sealed-envelope") => step({ kind, parameters: { ...SEALED, ...parameters } }, auction);
  const requirement = (change: Obj) => set("buyerRequirement", { requirementVersion: "1", required: [], ...change });
  const claim = (change: Obj) => requirement({ required: [{ scheme: "lei", verificationRequired: true, ...change }] });
  const deliverable = (value: Obj) => set("offering.deliverable", value);
  const accepted: Record<string, (scope: Obj) => void> = {
    "an expected size of 0": deliverable({ kind: "storage-program", expectedSizeBytes: 0 }),
    "an entitlement of 0 seconds": deliverable({ kind: "entitlement", durationSec: 0, renewable: false }),
    "a claim pinned to recipe version 1 with maxAge 0": claim({ recipeVersion: 1, maxAge: 0, parameters: { tier: "1" } }),
    "a rail at version 1": set("acceptedRails", [{ railId: "pay-dem", railVersion: 1 }]),
    "an RFQ of two turns and a one-second timeout": rfq({ maxTurns: 2, timeoutSec: 1, channelSubnet: "subnet", rfqInitiator: "buyer" }),
    "a reveal window of 60 seconds": sealed({ revealWindow: 60, channelSubnet: "subnet" }),
    "terms at their zero values": set("terms", { deadlineSecAfterCommit: 0, retentionYears: 0, conflictOfLawsRule: "seller-jurisdiction" }),
    "a rate phase without parameters": (scope) => { scope.pipeline = [{ kind: "negotiate-fixed-price" }, ...tail, { kind: "rate" }]; },
    "extended description members": set("offering.extendedDescriptionUrl", "https://desk.example/more"),
  };
  const rejected: Record<string, (scope: Obj) => void> = {
    "a negative expected size": deliverable({ kind: "storage-program", expectedSizeBytes: -1 }),
    "an expected size as a string": deliverable({ kind: "attested-payload", payloadFormat: "application/json", expectedSizeBytes: "10" }),
    "a schemaUrl that is not a string": deliverable({ kind: "storage-program", schemaUrl: 7 }),
    "a negative entitlement": deliverable({ kind: "entitlement", durationSec: -1, renewable: false }),
    "an empty payload format": deliverable({ kind: "attested-payload", payloadFormat: "" }),
    "a verification method without a kind": deliverable({ kind: "attested-payload", payloadFormat: "application/json", verificationMethod: {} }),
    "an external verification method that is a string": deliverable({ kind: "external", description: "receipt", verificationMethod: "tlsnotary" }),
    "no deliverable": deliverable(undefined as unknown as Obj),
    "an empty claim scheme": claim({ scheme: "" }),
    "a claim scheme that is not a string": claim({ scheme: 7 }),
    "a negative maxAge": claim({ maxAge: -1 }),
    "maxAge as a string": claim({ maxAge: "60" }),
    "recipe version 0": claim({ recipeVersion: 0 }),
    "a recipe version as a string": claim({ recipeVersion: "1" }),
    "claim parameters as a list": claim({ parameters: [] }),
    "a required entry that is not an object": requirement({ required: ["lei"] }),
    "required not a list": requirement({ required: {} }),
    "oneOf not a list": requirement({ oneOf: {} }),
    "a oneOf group that is not a list": requirement({ oneOf: [{ scheme: "lei", verificationRequired: true }] }),
    "a oneOf group with an incomplete claim": requirement({ oneOf: [[{ scheme: "lei" }]] }),
    "a primaryClaimSelector that is not a string": requirement({ primaryClaimSelector: 7 }),
    "no buyerRequirement": set("buyerRequirement", undefined),
    "a terms URL that is not a string": set("terms", { termsOfServiceUrl: 7 }),
    "a terms hash that is not a string": set("terms", { termsOfServiceHash: 7 }),
    "jurisdictions not a list": set("terms", { jurisdictions: "GB" }),
    "a jurisdiction that is not a string": set("terms", { jurisdictions: [7] }),
    "a rule-ref without a URI": set("terms", { conflictOfLawsRule: "rule-ref:" }),
    "an unknown conflict-of-laws rule": set("terms", { conflictOfLawsRule: "nearest-court" }),
    "a conflict-of-laws rule that is not a string": set("terms", { conflictOfLawsRule: 7 }),
    "an unknown acceptance model": set("terms", { acceptanceModel: "manual" }),
    "a negative retention": set("terms", { retentionYears: -1 }),
    "an unknown disclosure policy": set("terms", { transcriptDisclosurePolicy: "public" }),
    "a deadline as a string": set("terms", { deadlineSecAfterCommit: "3600" }),
    "no terms": set("terms", undefined),
    "an empty rail id": set("acceptedRails", [{ railId: "pay-dem" }, { railId: "" }]),
    "a rail id that is not a string": set("acceptedRails", [{ railId: "pay-dem" }, { railId: 7 }]),
    "rail version 0": set("acceptedRails", [{ railId: "pay-dem", railVersion: 0 }]),
    "a rail version as a string": set("acceptedRails", [{ railId: "pay-dem", railVersion: "1" }]),
    "rail parameters as a list": set("acceptedRails", [{ railId: "pay-dem", parameters: [] }]),
    "acceptedRails not a list": set("acceptedRails", { railId: "pay-dem" }),
    "requiredCapabilities not a list": set("requiredCapabilities", "SR-2"),
    "a capability that is not a string": set("requiredCapabilities", [7]),
    "an extended description URL that is not a string": set("offering.extendedDescriptionUrl", 7),
    "maxTurns as a string": rfq({ maxTurns: "6" }),
    "a timeout of 0": rfq({ timeoutSec: 0 }),
    "a timeout as a string": rfq({ timeoutSec: "300" }),
    "an RFQ subnet that is not a string": rfq({ channelSubnet: 7 }),
    "an unknown RFQ initiator": rfq({ rfqInitiator: "both" }),
    "a commit deadline as a string": sealed({ commitDeadline: "soon" }),
    "a reveal window as a string": sealed({ revealWindow: "3600" }),
    "an unknown selection rule": sealed({ selectionRule: "best" }),
    "a sealed-envelope subnet that is not a string": sealed({ channelSubnet: 7 }),
    "a procurement phase in demand mode": sealed({ auctionMode: "demand" }, "negotiate-sealed-envelope-procurement"),
    "a pay phase without parameters": (scope) => { scope.pipeline = [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "pay-dem" }]; },
    "rate parameters as a list": (scope) => { scope.pipeline = [{ kind: "negotiate-fixed-price" }, ...tail, { kind: "rate", parameters: [] }]; },
    "a pipeline entry that is not an object": (scope) => { scope.pipeline = [{ kind: "negotiate-fixed-price" }, ...tail, null]; },
  };
  assert.deepEqual(await verdicts(accepted), all(accepted, true));
  assert.deepEqual(await verdicts(rejected), all(rejected, false));
});

test("DACS-1 §6.3.1: the listing's IdentityBundle presentation is the publisher's own per-claim signature", async () => {
  const presented = async (presentation: (identity: Obj) => Obj | undefined) => (await verifyListing(listing(undefined, { presentation }))) !== null;
  assert.deepEqual({
    "a hex presentation signature": await presented((identity) => perClaim(identity)),
    "a base64url presentation signature": await presented((identity) => perClaim(identity, 0, "base64url")),
    "a signature entry beside another claim's": await presented((identity) => ({ kind: "per-claim", signatures: [{ ref: dids[1], signature: "00" }, ...perClaim(identity).signatures] })),
    "an SR-1 root presentation": await presented((identity) => ({ ...perClaim(identity), kind: "sr1-root" })),
    "no presentation": await presented(() => undefined),
    "signatures not a list": await presented((identity) => ({ kind: "per-claim", signatures: perClaim(identity).signatures[0] })),
    "only another claim's signature": await presented((identity) => ({ kind: "per-claim", signatures: [{ ...perClaim(identity).signatures[0], ref: dids[1] }] })),
    "a signature that is not a string": await presented(() => ({ kind: "per-claim", signatures: [{ ref: dids[0], signature: 7 }] })),
    "a signature by another key": await presented((identity) => perClaim(identity, 1)),
  }, {
    "a hex presentation signature": true, "a base64url presentation signature": true, "a signature entry beside another claim's": true,
    "an SR-1 root presentation": false, "no presentation": false, "signatures not a list": false,
    "only another claim's signature": false, "a signature that is not a string": false, "a signature by another key": false,
  });
});

const legacyScope = {
  listingId: "legacy", listingVersion: 1, agentId: dids[0], serviceId: "legacy", name: "Legacy", description: "Draft SDK listing",
  claimRequirements: [], supportedNegotiation: ["negotiate-fixed-price"], supportedPaymentRails: ["pay-dem"], supportedDelivery: ["deliver-attested-payload"],
};
const legacyValue = (signer = 0, scope: Obj = legacyScope) => sign(`dacs-listing:v1:${contentHash(scope)}`, signer, "hex");

test("current discriminators cannot fall back to the signed legacy listing profile", async () => {
  assert.equal((await verifyListing({ ...legacyScope, signature: legacyValue() }))?.profile, "legacy-sdk-v0.1");
  for (const dacsVersion of ["1", "2", null, 1]) {
    const scope = { ...legacyScope, dacsVersion };
    assert.equal(await verifyListing({ ...scope, signature: legacyValue(0, scope) }), null, String(dacsVersion));
  }
  const hybrids: Record<string, (scope: Obj) => void> = {
    "no delivery": (scope) => { (scope.pipeline as Obj[]).pop(); },
    "late Vet": (scope) => { (scope.pipeline as Obj[]).push({ kind: "vet-credentials" }); },
    "invalid identity version": set("seller.identity.bundleVersion", "2"),
    "missing tags": set("offering.tags", undefined),
    "forbidden empty parameters": (scope) => { (scope.pipeline as Obj[])[0].parameters = {}; },
    "forbidden nonempty parameters": (scope) => { (scope.pipeline as Obj[])[1].parameters = { unexpected: true }; },
  };
  const hybrid = (change: (scope: Obj) => void) => listing((scope) => {
    const { listingId: _id, listingVersion: _version, ...compatibility } = legacyScope;
    Object.assign(scope, compatibility);
    scope.pipeline = structuredClone(scope.pipeline);
    change(scope);
  });
  assert.equal((await verifyListing(hybrid(() => {})))?.profile, "dacs-v0.1");
  for (const [name, change] of Object.entries(hybrids)) {
    assert.equal(await verifyListing(hybrid(change)), null, name);
  }
});

test("legacy-sdk-v0.1 listings: an Ed25519 envelope by the agentId's own key", async () => {
  const envelope = (change: Obj = {}) => ({ algorithm: "ed25519", signer: dids[0], value: legacyValue(), ...change });
  const verdict = async (raw: Obj) => (await verifyListing(raw))?.profile ?? null;
  assert.deepEqual({
    "an envelope": await verdict({ ...legacyScope, signature: envelope() }),
    "a compact value": await verdict({ ...legacyScope, signature: legacyValue() }),
    "a 0x value": await verdict({ ...legacyScope, signature: envelope({ value: `0x${legacyValue()}` }) }),
    "another algorithm": await verdict({ ...legacyScope, signature: envelope({ algorithm: "ecdsa-secp256k1" }) }),
    "a signer that is not a string": await verdict({ ...legacyScope, signature: envelope({ signer: 7 }) }),
    "a value that is not a string": await verdict({ ...legacyScope, signature: envelope({ value: 7 }) }),
    "a value that is not a signature": await verdict({ ...legacyScope, signature: envelope({ value: "zz" }) }),
    "an envelope list": await verdict({ ...legacyScope, signature: [envelope()] }),
    "no signature": await verdict({ ...legacyScope }),
    "another signer's envelope": await verdict({ ...legacyScope, signature: envelope({ signer: dids[1], value: legacyValue(1) }) }),
    "another agent's listing": await verdict({ ...legacyScope, agentId: dids[1], signature: envelope({ value: legacyValue(0, { ...legacyScope, agentId: dids[1] }) }) }),
    "not a listing": await verdict({ listingId: "legacy", signature: envelope() }),
  }, {
    "an envelope": "legacy-sdk-v0.1", "a compact value": "legacy-sdk-v0.1", "a 0x value": "legacy-sdk-v0.1",
    "another algorithm": null, "a signer that is not a string": null, "a value that is not a string": null,
    "a value that is not a signature": null, "an envelope list": null, "no signature": null,
    "another signer's envelope": null, "another agent's listing": null, "not a listing": null,
  });
});

test("the indexer publishes a verified listing only when it is readable, bound to its owner, hash-pinned and in its validity window", async () => {
  const now = Date.now();
  const stored: Record<string, { data: Obj; owner: string }> = {};
  const anchor = (n: number, data: Obj, owner = keys[0]) => {
    const at = `stor-${(0xb000 + n).toString(16).padStart(40, "0")}`;
    stored[at] = { data, owner: `0x${owner}` };
    return at;
  };
  const named = (listingId: string, change: (scope: Obj) => void = () => {}) => listing((scope) => { scope.listingId = listingId; change(scope); });
  const pinned = named("pinned");
  const anchors = {
    published: anchor(1, named("published", (scope) => { scope.terms = { cancellationPolicy: "pre-commit" }; })),
    pinned: anchor(2, pinned),
    mispinned: anchor(3, named("mispinned")),
    expired: anchor(4, named("expired", set("validity", { notBefore: 1, notAfter: now - 60_000 }))),
    future: anchor(5, named("future", set("validity", { notBefore: now + 3_600_000 }))),
    // Inside its window, with an end still ahead: notBefore <= now <= notAfter.
    current: anchor(10, named("current", set("validity", { notBefore: now - 60_000, notAfter: now + 3_600_000 }))),
    foreign: anchor(6, named("foreign"), keys[1]),
    unsigned: anchor(7, named("unsigned", set("offering.title", 7))),
    legacy: anchor(8, { ...legacyScope, listingVersion: 3, signature: legacyValue(0, { ...legacyScope, listingVersion: 3 }) }),
    missing: `stor-${"f".repeat(40)}`,
  };
  // A draft SDK listing named only by serviceId and without a version is version 1.
  const { listingVersion: _, ...unversioned } = legacyScope;
  const unversionedAt = anchor(9, { ...unversioned, serviceId: "unversioned", listingId: undefined, signature: legacyValue(0, { ...unversioned, serviceId: "unversioned", listingId: undefined }) });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const entry = stored[String(input).split("/").pop() ?? ""];
    return entry ? Response.json({ success: true, owner: entry.owner, programName: "opaque", data: entry.data }) : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
  };
  try {
    const record = await indexRegistration({
      primaryClaim: dids[0], displayName: "Rules desk", listingAnchors: [...Object.values(anchors), unversionedAt],
      listingContentHashes: { [anchors.pinned]: `sha256-${contentHash({ ...pinned, signature: undefined })}`, [anchors.mispinned]: "0".repeat(64) },
    }, undefined, async () => { throw new Error("identity unavailable"); });
    const published = Object.fromEntries(record.listings.map((entry) => [entry.listingId, entry]));
    assert.deepEqual(Object.keys(published).sort(), ["current", "legacy", "pinned", "published", "unversioned"]);
    assert.equal(published.current.status, "active");
    assert.equal(published.legacy.version, 3);
    assert.equal(published.unversioned.version, 1);
    assert.equal(published.legacy.artifactProfile, "legacy-sdk-v0.1");
    assert.equal(published.published.artifactProfile, "dacs-v0.1");
    assert.deepEqual(published.published.terms, { cancellationPolicy: "pre-commit" });
    assert.deepEqual(published.published.buyerRequirement, { requirementVersion: "1", required: [] });
    assert.equal(published.published.status, "active");
    assert.equal(Object.hasOwn(published.published, "revocation"), false);
    // The current listing's IdentityBundle is carried for the identity tier; a legacy listing has none.
    assert.equal((record.identityBundle as Obj | undefined)?.presentedBy, dids[0]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("further listing rules: band floor, step order, claim binding and every-member checks", async () => {
  // The publisher (presentedBy) must be among the claims even when the signer is, and its presentation verifies.
  const otherPublisher = (scope: Obj) => {
    const identity: Obj = { bundleVersion: "1", presentedBy: dids[1], presentedAt: 1, claims: [{ ref: dids[0] }] };
    (scope.seller as Obj).identity = { ...identity, presentation: perClaim(identity, 1) };
  };
  const twoPays = (scope: Obj) => { scope.pipeline = [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" },
    { kind: "pay-dem", parameters: { rail: "pay-dem" } }, { kind: "pay-x402", parameters: { rail: "pay-x402" } }, { kind: "deliver-attested-payload" }]; };
  const claim = { scheme: "lei", verificationRequired: true };
  const accepted = {
    "a minPct of 0": pricedWith({ ...negotiable, minPct: 0 }, { kind: "negotiate-rfq", parameters: RFQ }),
    "two pay phases on accepted rails": (scope: Obj) => { twoPays(scope); scope.acceptedRails = [{ railId: "pay-dem" }, { railId: "pay-x402" }]; },
    "every oneOf group complete": set("buyerRequirement", { requirementVersion: "1", required: [], oneOf: [[claim], [claim, { ...claim, scheme: "domain" }]] }),
  };
  const rejected = {
    "a second negotiation after the commitment": (scope: Obj) => { scope.pipeline = [{ kind: "negotiate-fixed-price" }, ...tail, { kind: "negotiate-rfq", parameters: RFQ }]; },
    "a publisher outside the claims": otherPublisher,
    "a pay phase on a rail the listing does not accept, beside one it does": twoPays,
    "one unknown capability among known ones": set("requiredCapabilities", ["SR-2", "SR-9"]),
    "a fixedPriceFallback that is not a boolean": step({ kind: "negotiate-rfq", parameters: { ...RFQ, fixedPriceFallback: "yes" } }, negotiable),
    "one lowercase jurisdiction among valid ones": set("terms", { jurisdictions: ["GB", "gb"] }),
    "one jurisdiction that is not a string": set("terms", { jurisdictions: ["GB", 7] }),
    "a conflict-of-laws rule-ref that is not a string": set("terms", { conflictOfLawsRule: ["rule-ref:https://law.example"] }),
    "one incomplete oneOf group": set("buyerRequirement", { requirementVersion: "1", required: [], oneOf: [[claim], [{ scheme: "domain" }]] }),
    "one incomplete claim within a group": set("buyerRequirement", { requirementVersion: "1", required: [], oneOf: [[claim, { scheme: "domain" }]] }),
    "one oneOf group that is not a list": set("buyerRequirement", { requirementVersion: "1", required: [], oneOf: [[claim], claim] }),
  };
  assert.deepEqual(await verdicts(accepted), all(accepted, true));
  assert.deepEqual(await verdicts(rejected), all(rejected, false));
});

test("RB-3 retention carries forward only this listing version's own revoked record and binding", async () => {
  const at = `stor-${"c1".padStart(40, "0")}`;
  const current = listing((scope) => { scope.listingId = "retained"; });
  const hash = contentHash({ ...current, signature: undefined });
  const binding = { sellerPrimaryClaim: dids[0], listingId: "retained", listingVersion: 1, listingContentHash: hash,
    logicalAddress: `dacs1-revoked:${dids[0].replace(/:/g, "%3A")}:retained:v1`, markerAnchor: { kind: "storage-program", locator: `stor-${"d1".padStart(40, "0")}` }, markerContentHash: "e".repeat(64) };
  const prior = (listings: Obj[]) => ({ primaryClaim: dids[0], displayName: "Rules desk", identityTier: "self-declared", cci: [], listings, deals: [] } as never);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => String(input).endsWith(at)
    ? Response.json({ success: true, owner: `0x${keys[0]}`, programName: "opaque", data: current }) : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
  try {
    const statusWith = async (listings: Obj[]) => {
      const record = await indexRegistration({ primaryClaim: dids[0], displayName: "Rules desk", listingAnchors: [at] }, prior(listings),
        async () => { throw new Error("identity unavailable"); });
      const published = record.listings[0] as unknown as Obj;
      return `${published.status} ${Object.hasOwn(published, "revocation") ? "with binding" : "without binding"}`;
    };
    assert.equal(await statusWith([{ listingId: "retained", contentHash: hash, status: "revoked", revocation: binding }]), "revoked with binding");
    assert.equal(await statusWith([{ listingId: "retained", contentHash: "f".repeat(64), status: "revoked", revocation: { ...binding, listingContentHash: "f".repeat(64) } }]),
      "active without binding", "another version's revocation");
    assert.equal(await statusWith([{ listingId: "retained", contentHash: hash, status: "active", revocation: binding }]),
      "active without binding", "an active record's stray binding");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("PIPE-1/VPC and required listing schema reject correctly signed deficient listings", async () => {
  const bad: Record<string, (scope: Obj) => void> = {
    "missing delivery": (s) => { s.pipeline = (s.pipeline as Obj[]).filter((p) => !String(p.kind).startsWith("deliver-")); },
    "vet after negotiation": (s) => { (s.pipeline as Obj[]).splice(1, 0, { kind: "vet-credentials" }); },
    "vet after payment": (s) => { (s.pipeline as Obj[]).push({ kind: "vet-credentials" }); },
    "identity version 2": set("seller.identity.bundleVersion", "2"),
    "missing presentedAt": set("seller.identity.presentedAt", undefined),
    "nonnumeric presentedAt": set("seller.identity.presentedAt", "1"),
    "malformed claim among valid claims": (s) => { (at(s, "seller.identity").claims as unknown[]).push(null); },
    "malformed ref among valid claims": (s) => { (at(s, "seller.identity").claims as unknown[]).push({ ref: 7 }); },
    "missing tags": set("offering.tags", undefined),
    "non-array tags": set("offering.tags", {}),
  };
  for (const kind of ["vet-credentials", "negotiate-fixed-price", "commit-agreement", "commit-payee-bound-agreement", "deliver-storage-program", "deliver-entitlement", "deliver-attested-payload"]) {
    for (const parameters of [{}, { authorization: "skip" }]) bad[`${kind} with ${JSON.stringify(parameters)}`] = (s) => {
      const pipeline = s.pipeline as Obj[];
      const index = pipeline.findIndex((p) => p.kind === kind);
      if (index >= 0) pipeline[index] = { kind, parameters };
      else if (kind === "vet-credentials") pipeline.unshift({ kind, parameters });
      else if (kind.startsWith("commit-")) pipeline[1] = { kind, parameters };
      else pipeline[3] = { kind, parameters };
    };
  }
  for (const [name, change] of Object.entries(bad)) {
    const raw = listing((scope) => {
      change(scope);
      // Keep both signature layers valid, so a stale presentation cannot mask a missing schema gate.
      const identity = at(scope, "seller.identity");
      const identityScope = { ...identity }; delete identityScope.presentation;
      identity.presentation = perClaim(identityScope);
    });
    assert.equal(await verifyListing(raw), null, name);
  }
});

test("unread unauthenticated revocation hints cannot suppress a verified listing", async () => {
  const { admitRevocationCandidates, hasPendingRevocationCandidates } = await import("../src/catalog/store.js");
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [403, 404]) {
      const listed = listing((s) => { s.listingId = `unread-revocation-${status}`; });
      const listingAt = `stor-${String(status).padStart(40, "0")}`;
      const markerAt = `stor-${String(status + 1).padStart(40, "0")}`;
      const hash = contentHash((({ signature: _, ...scope }) => scope)(listed));
      admitRevocationCandidates(hash, [{ locator: markerAt }]);
      globalThis.fetch = async (input) => String(input).endsWith(listingAt)
        ? Response.json({ success: true, owner: `0x${keys[0]}`, data: listed })
        : Response.json({ success: false, errorCode: status === 403 ? "PERMISSION_DENIED" : "NOT_FOUND" }, { status });
      for (let pass = 0; pass < 2; pass++) {
        const record = await indexRegistration({ primaryClaim: dids[0], displayName: "Rules desk", listingAnchors: [listingAt] }, undefined,
          async () => { throw new Error("offline"); });
        assert.equal(record.listings[0]?.status, "active"); assert.equal(hasPendingRevocationCandidates(hash), true);
      }
      // Successfully read invalid bytes can be rejected, completing the pending check.
      globalThis.fetch = async (input) => Response.json({ success: true, owner: `0x${keys[0]}`, data: String(input).endsWith(listingAt) ? listed : "invalid marker bytes" });
      const realNow = Date.now; Date.now = () => realNow() + 60_000;
      let resolved;
      try { resolved = await indexRegistration({ primaryClaim: dids[0], displayName: "Rules desk", listingAnchors: [listingAt] }, undefined,
        async () => { throw new Error("offline"); }); } finally { Date.now = realNow; }
      assert.equal(resolved.listings[0].status, "active");
    }
  } finally { globalThis.fetch = originalFetch; }
});
