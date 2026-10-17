import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import type { BundleVerification } from "../vendor/dacs-sdk/dist/agent/verifyBundleCore.js";

// The labelled legacy-sdk-v0.1 deal path: the strict policy the browser verdict and the indexer
// layer on the pinned SDK's verifyBundleCore, and one end-to-end deal through the indexer.
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-legacy-rules-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
const policy = await import("../src/catalog/bundlePolicy.js");
const { indexRegistration } = await import("../src/catalog/indexer.js");
const { resolveProgramAddress } = await import("../src/catalog/store.js");
test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));

type Obj = Record<string, unknown>;
const seeds = [91, 92, 93].map((byte) => Uint8Array.from(Buffer.alloc(32, byte)));
const dids = seeds.map((seed) => `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`);
const [BUYER, SELLER, OUTSIDER] = [0, 1, 2];
const sign = (message: string, signer: number, encoding: BufferEncoding = "hex") =>
  Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKeyFromSeed(seeds[signer]))).toString(encoding);
const at = (n: number) => `stor-${(0xd000 + n).toString(16).padStart(40, "0")}`;
const JOB = "legacy-job";

const listingScope: Obj = {
  listingId: "legacy-svc", listingVersion: 1, agentId: dids[SELLER], serviceId: "legacy-svc", name: "Legacy", description: "Draft SDK service",
  category: "legacy.test", claimRequirements: [], supportedNegotiation: ["negotiate-fixed-price"], supportedPaymentRails: ["pay-dem"], supportedDelivery: ["deliver-attested-payload"],
};
const listing = { ...listingScope, signature: { algorithm: "ed25519", signer: dids[SELLER], value: sign(`dacs-listing:v1:${contentHash(listingScope)}`, SELLER) } };
const agreementScope: Obj = {
  jobId: JOB, pattern: "negotiate-fixed-price", buyer: dids[BUYER], seller: dids[SELLER], listingRef: at(1),
  price: { amount: "5", asset: "DEM", decimals: 0, rail: "pay-dem" }, delivery: { phase: "deliver-attested-payload", format: "application/json" }, expiresAt: "2027-01-01T00:00:00Z",
};
const agreementSignature = (signer: number, as = signer, field = "signer") =>
  ({ algorithm: "ed25519", [field]: dids[as], value: sign(`dacs-agreement:v1:${contentHash(agreementScope)}`, signer) });
const agreement = { ...agreementScope, signatures: [agreementSignature(BUYER), agreementSignature(SELLER)] };
const evidenceScope: Obj = {
  evidenceVersion: "1", jobId: JOB, phase: "pay-dem", phaseIndex: 0, outcome: "success",
  paymentTxRefs: [{ rail: "demos", txHash: `0x${"ab".repeat(32)}`, kind: "payment" }], paymentAmount: { amount: "5", currency: "DEM" },
  settlementFinality: { model: "bft-final", finalityBlocks: 1, finalityObservedAt: 100 }, observedAt: 100,
};
const evidence = { ...evidenceScope, signature: { algorithm: "ed25519", signer: dids[SELLER], value: sign(`dacs-evidence:v1:${contentHash(evidenceScope)}`, SELLER) } };

function verification(change: (bundle: NonNullable<BundleVerification["bundle"]>) => void = () => {}): BundleVerification {
  const bundle = {
    bundleVersion: "0.1", jobId: JOB, outcome: "completed", anchoredByRole: "buyer",
    listingRef: { listingId: "legacy-svc", version: 1, contentHash: contentHash(listingScope) },
    agreementRef: { kind: "dacs-3-agreement", id: "agreement-legacy", contentHash: contentHash(agreementScope) },
    parties: [{ role: "buyer", primaryClaim: dids[BUYER], bundleHash: "b" }, { role: "seller", primaryClaim: dids[SELLER], bundleHash: "s" }],
    phaseSummary: [], vetRecords: [], settlementEvidence: [{ kind: "dacs-4-evidence", id: "evidence-legacy", contentHash: contentHash(evidenceScope) }],
    recipeRegistryVersion: 1, railRegistryVersion: 1, finalisedAt: 120,
  } as NonNullable<BundleVerification["bundle"]>;
  change(bundle);
  return {
    ok: true, fullyVerified: true, bundle,
    signatures: [{ party: dids[BUYER], verdict: "valid" }, { party: dids[SELLER], verdict: "valid" }],
    refs: [{ kind: "dacs-3-agreement", id: "agreement-legacy", verdict: "ok" }, { kind: "dacs-4-evidence", id: "evidence-legacy", verdict: "ok" }, { kind: "dacs-1-listing", id: "legacy-svc", verdict: "ok" }],
  };
}
const artifacts = (): Array<{ kind: string; raw: Obj }> => [{ kind: "dacs-3-agreement", raw: structuredClone(agreement) }, { kind: "dacs-4-evidence", raw: structuredClone(evidence) }, { kind: "dacs-1-listing", raw: structuredClone(listing) }];

test("strict refs: the SDK's ref verdicts, the positional kinds and ids, the parties and the hashes all bind", async () => {
  const strict = (value: BundleVerification, list = artifacts()) => policy.refsPassStrictPolicy(value, list);
  assert.equal(await strict(verification()), true);
  const cases: Record<string, [BundleVerification, ReturnType<typeof artifacts>?]> = {
    "an SDK verification that failed": [{ ...verification(), ok: false }],
    "a ref the SDK did not resolve": [{ ...verification(), refs: verification().refs.map((ref, n) => n === 1 ? { ...ref, verdict: "missing" as const } : ref) }],
    "one artifact fewer than expected": [verification(), artifacts().slice(0, 2)],
    "one ref verdict fewer than expected": [{ ...verification(), refs: verification().refs.slice(0, 2) }],
    "an agreementRef of another kind": [verification((bundle) => { bundle.agreementRef = { ...bundle.agreementRef, kind: "dacs-2-verifyresult" }; })],
    "evidence of another kind": [verification((bundle) => { bundle.settlementEvidence = [{ ...bundle.settlementEvidence[0], kind: "dacs-3-agreement" }]; })],
    "a vet record of another kind": [verification((bundle) => { bundle.vetRecords = [{ kind: "dacs-4-evidence", id: "vet", contentHash: "f".repeat(64) }]; })],
    "a ref id that differs from the bundle's": [{ ...verification(), refs: verification().refs.map((ref, n) => n === 0 ? { ...ref, id: "agreement-other" } : ref) }],
    "a ref kind that differs from the bundle's": [{ ...verification(), refs: verification().refs.map((ref, n) => n === 1 ? { ...ref, kind: "dacs-2-verifyresult" } : ref) }],
    "an artifact of another kind in the agreement's place": [verification(), [{ kind: "dacs-4-evidence", raw: structuredClone(evidence) }, ...artifacts().slice(1)]],
    "two buyers": [verification((bundle) => { bundle.parties = [...bundle.parties, { role: "buyer", primaryClaim: dids[OUTSIDER], bundleHash: "o" }]; })],
    "no seller": [verification((bundle) => { bundle.parties = bundle.parties.slice(0, 1); })],
    "an agreement for another job": [verification(), [{ kind: "dacs-3-agreement", raw: { ...agreement, jobId: "other" } }, ...artifacts().slice(1)]],
    "evidence for another job": [verification(), [artifacts()[0], { kind: "dacs-4-evidence", raw: { ...evidence, jobId: "other" } }, artifacts()[2]]],
    "an agreement whose seller is not the bundle's": [verification(), [{ kind: "dacs-3-agreement", raw: { ...agreement, seller: dids[OUTSIDER] } }, ...artifacts().slice(1)]],
    "an agreement whose buyer is not the bundle's": [verification(), [{ kind: "dacs-3-agreement", raw: { ...agreement, buyer: dids[OUTSIDER] } }, ...artifacts().slice(1)]],
    "evidence that no longer hashes to its ref": [verification(), [artifacts()[0], { kind: "dacs-4-evidence", raw: { ...evidence, observedAt: 101 } }, artifacts()[2]]],
    "a listing that no longer hashes to its ref": [verification(), [...artifacts().slice(0, 2), { kind: "dacs-1-listing", raw: { ...listing, name: "Renamed" } }]],
    "a listing with no canonical form": [verification(), [...artifacts().slice(0, 2), { kind: "dacs-1-listing", raw: { ...listing, extra: JSON.parse("1e400") } }]],
    "an unsigned evidence": [verification(), [artifacts()[0], { kind: "dacs-4-evidence", raw: evidenceScope }, artifacts()[2]]],
  };
  const results: Record<string, boolean> = {};
  for (const [name, [value, list]] of Object.entries(cases)) results[name] = await strict(value, list);
  assert.deepEqual(results, Object.fromEntries(Object.keys(cases).map((name) => [name, false])));
});

test("referenced legacy artifacts carry exactly one signature form, each entry an Ed25519 envelope that verifies", async () => {
  const parties = new Set([dids[BUYER], dids[SELLER]]);
  const signed = (kind: string, raw: Obj, claims = parties) => policy.verifyReferencedArtifactSignature({ kind, raw }, claims);
  assert.equal(await signed("dacs-3-agreement", agreement), true);
  assert.equal(await signed("dacs-3-agreement", { ...agreementScope, signatures: [agreementSignature(BUYER, BUYER, "party"), agreementSignature(SELLER, SELLER, "party")] }), true, "party names the signer too");
  assert.equal(await signed("dacs-4-evidence", evidence), true);
  assert.equal(await signed("dacs-1-listing", listing), true);
  const vet = { recordVersion: "1", jobId: JOB };
  assert.equal(await signed("dacs-2-verifyresult", { ...vet, signature: { algorithm: "ed25519", signer: dids[OUTSIDER], value: sign(`dacs-composite:v1:${contentHash(vet)}`, OUTSIDER) } }), true,
    "a vet record may be signed by an external verifier");
  const rejected: Record<string, Promise<boolean>> = {
    "an unknown artifact kind": signed("dacs-9-other", evidence),
    "both signature forms": signed("dacs-4-evidence", { ...evidence, signatures: [evidence.signature] }),
    "neither signature form": signed("dacs-4-evidence", evidenceScope),
    "an empty signatures list": signed("dacs-4-evidence", { ...evidenceScope, signatures: [] }),
    "a vet record with an empty signatures list": signed("dacs-2-verifyresult", { ...vet, signatures: [] }),
    "a signatures member that is not a list": signed("dacs-4-evidence", { ...evidenceScope, signatures: evidence.signature }),
    "a singular signature that is a list": signed("dacs-4-evidence", { ...evidenceScope, signature: [evidence.signature] }),
    "a singular signature that is a string": signed("dacs-4-evidence", { ...evidenceScope, signature: evidence.signature.value }),
    "an entry that is not an object": signed("dacs-3-agreement", { ...agreementScope, signatures: [...agreement.signatures, "sig"] }),
    "an entry with another algorithm": signed("dacs-4-evidence", { ...evidenceScope, signature: { ...evidence.signature, algorithm: "ecdsa-secp256k1" } }),
    "an entry without a signer": signed("dacs-4-evidence", { ...evidenceScope, signature: { algorithm: "ed25519", value: evidence.signature.value } }),
    "an entry whose value is not a string": signed("dacs-4-evidence", { ...evidenceScope, signature: { ...evidence.signature, value: 7 } }),
    "an entry whose value is not a signature": signed("dacs-4-evidence", { ...evidenceScope, signature: { ...evidence.signature, value: "zz" } }),
    "an entry that does not verify": signed("dacs-4-evidence", { ...evidenceScope, observedAt: 1, signature: evidence.signature }),
    "an agreement signed by the buyer alone": signed("dacs-3-agreement", { ...agreementScope, signatures: [agreementSignature(BUYER)] }),
    "an agreement whose buyer is not a string": signed("dacs-3-agreement", { ...agreementScope, buyer: 7, signatures: agreement.signatures }),
    "an agreement whose seller is not a string": signed("dacs-3-agreement", { ...agreementScope, seller: 7, signatures: agreement.signatures }),
    "evidence signed only by an outsider": signed("dacs-4-evidence", { ...evidenceScope, signature: { algorithm: "ed25519", signer: dids[OUTSIDER], value: sign(`dacs-evidence:v1:${contentHash(evidenceScope)}`, OUTSIDER) } }),
    "evidence with no parties to bind": signed("dacs-4-evidence", evidence, new Set()),
    "an unsigned listing": signed("dacs-1-listing", listingScope),
  };
  const results: Record<string, boolean> = {};
  for (const [name, verdict] of Object.entries(rejected)) results[name] = await verdict;
  assert.deepEqual(results, Object.fromEntries(Object.keys(rejected).map((name) => [name, false])));
});

test("the bundle's own signature entries must mirror the SDK's verdicts, every one valid", () => {
  const value = verification();
  const raw = (change: (entries: Obj[]) => unknown = (entries) => entries) =>
    ({ signatures: change([{ algorithm: "ed25519", party: dids[BUYER], value: "x" }, { algorithm: "ed25519", party: dids[SELLER], value: "y" }]) });
  assert.equal(policy.hasRequiredBundleSignatures(value, raw()), true);
  const rejected: Record<string, boolean> = {
    "no SDK bundle": policy.hasRequiredBundleSignatures({ ...value, bundle: undefined }, raw()),
    "no raw bundle": policy.hasRequiredBundleSignatures(value, null),
    "a raw bundle that is a list": policy.hasRequiredBundleSignatures(value, [raw()]),
    "a raw bundle that is a string": policy.hasRequiredBundleSignatures(value, "bundle"),
    "a singular signature too": policy.hasRequiredBundleSignatures(value, { ...raw(), signature: {} }),
    "signatures not a list": policy.hasRequiredBundleSignatures(value, raw((entries) => entries[0])),
    "one entry fewer": policy.hasRequiredBundleSignatures(value, raw((entries) => entries.slice(0, 1))),
    "an entry that is not an object": policy.hasRequiredBundleSignatures(value, raw((entries) => [entries[0], "y"])),
    "an entry that is a list": policy.hasRequiredBundleSignatures(value, raw((entries) => [entries[0], [entries[1]]])),
    "an entry with another algorithm": policy.hasRequiredBundleSignatures(value, raw((entries) => [entries[0], { ...entries[1], algorithm: "sr1-aggregate" }])),
    "entries in another order": policy.hasRequiredBundleSignatures(value, raw((entries) => [entries[1], entries[0]])),
    "an entry whose value is not a string": policy.hasRequiredBundleSignatures(value, raw((entries) => [entries[0], { ...entries[1], value: 7 }])),
    "an entry whose value is empty": policy.hasRequiredBundleSignatures(value, raw((entries) => [entries[0], { ...entries[1], value: "" }])),
    "an SDK verdict that is not valid": policy.hasRequiredBundleSignatures({ ...value, signatures: [value.signatures[0], { ...value.signatures[1], verdict: "unverified" }] }, raw()),
    "no signatures at all": policy.hasRequiredBundleSignatures({ ...value, signatures: [] }, raw((entries) => entries.slice(0, 0))),
  };
  assert.deepEqual(rejected, Object.fromEntries(Object.keys(rejected).map((name) => [name, false])));
});

test("a registered deal binds the bundle's single buyer and seller, and the registered copy role", () => {
  const deal = { jobId: JOB, rail: "pay-dem", buyerBundleRef: at(2), owners: { buyer: dids[BUYER], seller: dids[SELLER] } };
  const matches = (change: (bundle: NonNullable<BundleVerification["bundle"]>) => void, catalogSeller = dids[SELLER]) =>
    policy.bundleMatchesRegisteredDeal(verification(change).bundle, deal, catalogSeller);
  assert.equal(matches(() => {}), true);
  assert.equal(policy.bundleMatchesRegisteredDeal(undefined, deal, dids[SELLER]), false);
  assert.equal(matches((bundle) => { bundle.parties = [...bundle.parties, { role: "buyer", primaryClaim: dids[OUTSIDER], bundleHash: "o" }]; }), false);
  assert.equal(matches((bundle) => { bundle.parties = [...bundle.parties, { role: "seller", primaryClaim: dids[OUTSIDER], bundleHash: "o" }]; }), false);
  assert.equal(matches((bundle) => { bundle.parties[1] = { ...bundle.parties[1], primaryClaim: dids[OUTSIDER] }; }, dids[OUTSIDER]), false, "the registered seller differs");
  assert.equal(matches(() => {}, dids[OUTSIDER]), false, "another catalog seller");
  // The unhashed copy role must match a registered address; an unknown address never matches.
  const bundle = { anchoredByRole: "buyer" };
  assert.equal(policy.bundleMatchesRegisteredAnchor(bundle, at(2).toUpperCase(), at(2), at(3)), true);
  assert.equal(policy.bundleMatchesRegisteredAnchor({ anchoredByRole: undefined }, at(9), at(2), undefined), false);
  assert.equal(policy.bundleMatchesRegisteredAnchor(undefined, at(2), at(2), at(3)), false);
  assert.equal(policy.registeredAnchorRole(at(3), 7, at(3)), "seller");
});

test("browser verdict: registered owners must be an object naming both parties", () => {
  const value = verification();
  const registered = { owners: { buyer: dids[BUYER], seller: dids[SELLER] }, buyerBundleRef: at(2), sellerBundleRef: at(3) };
  const verdict = (owners: unknown) => policy.browserDealVerdict({ verification: value, bundleRef: at(2), buyerOwner: dids[BUYER], expectedSeller: dids[SELLER],
    registered: { ...registered, owners }, signaturesOk: true, refsOk: true }).verdict;
  assert.equal(verdict(registered.owners), "strict-pass");
  for (const owners of ["owners", [registered.owners], { buyer: dids[BUYER] }, { buyer: dids[BUYER], seller: 7 }, { buyer: dids[OUTSIDER], seller: dids[SELLER] }]) {
    assert.equal(verdict(owners), "fail", JSON.stringify(owners));
  }
});

test("cancellation terms come only from the strict-verified listing the bundle pins by id, version and hash", () => {
  const pinned = (scope: Obj, change: (bundle: NonNullable<BundleVerification["bundle"]>) => void = () => {}) => policy.verifiedListingTerms(
    verification((bundle) => { bundle.listingRef = { listingId: "legacy-svc", version: 1, contentHash: contentHash(scope) }; change(bundle); }),
    [{ kind: "dacs-1-listing", raw: { ...scope, signature: "verified-by-strict-policy" } }], true);
  const terms = { cancellationPolicy: "pre-commit" };
  assert.deepEqual(pinned({ ...listingScope, terms }), terms);
  const { listingId: _, ...byServiceId } = listingScope;
  assert.deepEqual(pinned({ ...byServiceId, terms }), terms, "a draft listing named by serviceId");
  const { listingVersion: __, ...unversioned } = listingScope;
  assert.deepEqual(pinned({ ...unversioned, version: 1, terms }), terms, "the draft version member");
  assert.deepEqual(pinned({ ...unversioned, terms }), terms, "an unversioned draft listing is version 1");
  for (const [name, scope] of Object.entries({
    "a version of 0": { ...listingScope, listingVersion: 0, terms }, "a version as a string": { ...listingScope, listingVersion: "1", terms },
    "terms as a list": { ...listingScope, terms: [terms] }, "no terms": { ...listingScope }, "a listing for another id": { ...listingScope, listingId: "other", terms },
  })) assert.equal(pinned(scope), undefined, name);
  assert.equal(pinned({ ...listingScope, terms }, (bundle) => { bundle.listingRef = { ...bundle.listingRef, version: 2 }; }), undefined, "another pinned version");
  assert.equal(policy.verifiedListingTerms(verification(), [], true), undefined, "no listing artifact");
  assert.equal(policy.verifiedListingTerms(undefined, [], true), undefined);
  assert.equal(policy.bundleCategory(undefined, new Map([["legacy-svc", "legacy.test"]])), undefined);
});

test("§10.5.1 reconciliation leaves unverified records and lone verified copies untouched", () => {
  const record = (change: Obj = {}) => ({ jobId: JOB, rail: "pay-dem", buyerBundleRef: at(2), owners: { buyer: dids[BUYER], seller: dids[SELLER] },
    signatureVerified: true, refsVerified: true, reputationEligible: true, bundleContentHash: "1".repeat(64), verifiedAt: 1, ...change });
  const out = policy.dedupeVerifiedDeals([record({ refsVerified: false, reputationEligible: false }), record({ refsVerified: false, reputationEligible: false }), record({ buyerBundleRef: at(3) })]);
  assert.deepEqual(out.map((deal) => [deal.buyerBundleRef, deal.refsVerified, deal.reputationEligible]),
    [[at(2), false, false], [at(2), false, false], [at(3), true, true]]);
});

test("an SDK-profile deal verifies end to end on the labelled legacy path, and each copy must be strict", async () => {
  // The legacy path is chosen only when neither copy carries the current bundleVersion "1" discriminator.
  const bundleScope: Obj = { ...verification().bundle } as Obj;
  delete bundleScope.anchoredByRole;
  const bundleSignature = (signer: number) => ({ party: dids[signer], algorithm: "ed25519", value: sign(`dacs-bundle:v1:${contentHash(bundleScope)}`, signer, "base64url") });
  const copy = (anchoredByRole: string, change: Obj = {}) => ({ ...bundleScope, signatures: [bundleSignature(BUYER), bundleSignature(SELLER)], anchoredByRole, ...change });
  const owner = `0x${dids[SELLER].slice(-64)}`;
  const run = async (stored: Record<string, Obj>, registered: Obj = {}) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const data = stored[String(input).split("/").pop() ?? ""];
      return data ? Response.json({ success: true, owner, programName: "opaque", data }) : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
    };
    try {
      return await indexRegistration({ primaryClaim: dids[SELLER], displayName: "Legacy seller", listingAnchors: [at(1)],
        deals: [{ jobId: JOB, rail: "pay-dem", buyerBundleRef: at(2), sellerBundleRef: at(3), owners: { buyer: dids[BUYER], seller: dids[SELLER] }, ...registered }] },
      undefined, async () => { throw new Error("identity unavailable"); });
    } finally {
      globalThis.fetch = originalFetch;
    }
  };
  const base = {
    [at(1)]: listing, [at(2)]: copy("buyer"), [at(3)]: copy("seller"),
    [resolveProgramAddress(dids[BUYER], `dacs3:agreement:${JOB}`)!]: agreement,
    [resolveProgramAddress(dids[BUYER], `dacs4:evidence:${JOB}`)!]: evidence,
  };
  const record = await run(base);
  assert.equal(record.deals.length, 1);
  assert.deepEqual({ ...record.deals[0], verifiedAt: 0, anchorTimestamp: undefined }, {
    jobId: JOB, rail: "pay-dem", buyerBundleRef: at(2), sellerBundleRef: at(3), owners: { buyer: dids[BUYER], seller: dids[SELLER] },
    signatureVerified: true, refsVerified: true, outcome: "completed", sellerOutcome: "completed", anchoredByRole: "seller",
    bundleContentHash: contentHash(bundleScope), fullSignatureStanding: true, reputationEligible: true, cancellationNeutral: false, orchestratorFaultNeutral: false,
    finalisedAt: 120, anchorTimestamp: undefined, category: "legacy.test", verifiedAt: 0,
    // SB-1 on the legacy profile: a pay-dem TxRef keys as demos:{hash}, under the evidence's own phaseIndex.
    settlementTxIds: [{ id: `demos:${"ab".repeat(32)}`, observedAt: 100, phaseIndex: 0, evidenceHash: contentHash(evidenceScope) }],
  });
  assert.equal(record.reputation.completed, 1);
  assert.equal((await run(base, { orchestratorFaultNeutral: true })).deals[0].orchestratorFaultNeutral, false, "registration cannot grant FAB neutrality to a legacy copy");
  const verdict = async (stored: Record<string, Obj>, registered: Obj = {}) => {
    const deal = (await run(stored, registered)).deals[0];
    return `${deal.refsVerified ? "verified" : "unverified"} ${deal.reputationEligible ? "eligible" : "ineligible"} ${deal.sellerOutcome}`;
  };
  const evidenceAt = resolveProgramAddress(dids[BUYER], `dacs4:evidence:${JOB}`)!;
  // A seller copy that is strict on its own but reports another outcome than the buyer's (§10.4.3(d)).
  const divergentScope = { ...bundleScope, outcome: "failed-perm" };
  const divergentSignature = (signer: number) => ({ party: dids[signer], algorithm: "ed25519", value: sign(`dacs-bundle:v1:${contentHash(divergentScope)}`, signer, "base64url") });
  const divergentSeller = { ...divergentScope, signatures: [divergentSignature(BUYER), divergentSignature(SELLER)], anchoredByRole: "seller" };
  assert.deepEqual({
    "no seller copy": await verdict({ ...base, [at(3)]: undefined as unknown as Obj }),
    "a seller copy anchored as the buyer": await verdict({ ...base, [at(3)]: copy("buyer") }),
    "a buyer copy anchored as the seller": await verdict({ ...base, [at(2)]: copy("seller") }),
    "a seller copy signed by the buyer alone": await verdict({ ...base, [at(3)]: { ...copy("seller"), signatures: [bundleSignature(BUYER)] } }),
    "missing evidence": await verdict({ ...base, [evidenceAt]: undefined as unknown as Obj }),
    "a seller copy also signed by an outsider": await verdict({ ...base, [at(3)]: { ...copy("seller"), signatures: [bundleSignature(BUYER), bundleSignature(SELLER), bundleSignature(OUTSIDER)] } }),
    "a registered deal naming another job than its bundles": await verdict(base, { jobId: "another-job" }),
    "a registered deal naming another buyer than its bundles": await verdict(base, { owners: { buyer: dids[OUTSIDER], seller: dids[SELLER] } }),
    "two strict copies that diverge": await verdict({ ...base, [at(3)]: divergentSeller }),
  }, {
    "no seller copy": "unverified ineligible completed",
    "a seller copy anchored as the buyer": "unverified ineligible completed",
    "a buyer copy anchored as the seller": "unverified ineligible completed",
    "a seller copy signed by the buyer alone": "unverified ineligible completed",
    "missing evidence": "unverified ineligible completed",
    "a seller copy also signed by an outsider": "unverified ineligible completed",
    "a registered deal naming another job than its bundles": "unverified ineligible completed",
    "a registered deal naming another buyer than its bundles": "unverified ineligible completed",
    "two strict copies that diverge": "unverified ineligible failed-perm",
  });
  // Signature order is not significant.
  assert.equal(await verdict({ ...base, [at(3)]: { ...copy("seller"), signatures: [bundleSignature(SELLER), bundleSignature(BUYER)] } }), "verified eligible completed");
  // A copy carrying the current discriminator is verified as a current bundle, never retried as legacy.
  const current = await verdict({ ...base, [at(2)]: copy("buyer", { bundleVersion: "1" }), [at(3)]: copy("seller", { bundleVersion: "1" }) });
  assert.equal(current, "unverified ineligible undefined");
  for (const discriminator of [{ bundleVersion: "1" }, { faultBundleVersion: "1" }]) {
    const selected = await run({ ...base, [at(3)]: copy("seller", discriminator) });
    assert.equal(selected.deals[0].refsVerified, false);
    assert.equal(selected.deals[0].reputationEligible, false);
    assert.equal(selected.reputation.completed, 0);
  }
  const signedCopies = (buyerScope: Obj, sellerScope = buyerScope) => {
    const signed = (scope: Obj, role: string) => ({ ...scope, anchoredByRole: role,
      signatures: [BUYER, SELLER].map((signer) => ({ party: dids[signer], algorithm: "ed25519", value: sign(`dacs-bundle:v1:${contentHash(scope)}`, signer, "base64url") })) });
    return { [at(2)]: signed(buyerScope, "buyer"), [at(3)]: signed(sellerScope, "seller") };
  };
  for (const [buyerOutcome, sellerOutcome] of [["failed-perm", "failed-counterparty"], ["failed-counterparty", "failed-perm"],
    ["aborted-by-self", "aborted-by-other"], ["aborted-by-other", "aborted-by-self"], ["failed-substrate", "failed-substrate"]]) {
    const buyer = { ...bundleScope, outcome: buyerOutcome }; const seller = { ...bundleScope, outcome: sellerOutcome };
    const stored = { ...base, ...signedCopies(buyer, seller) };
    const result = await run(stored);
    assert.equal(result.deals[0].refsVerified, true, sellerOutcome);
    assert.equal(result.deals[0].sellerOutcome, sellerOutcome);
    assert.equal(result.deals[0].anchoredByRole, "seller");
    assert.equal(result.deals[0].bundleContentHash, contentHash(seller));
    assert.equal(result.reputation.completed, 0);
    const fallback = await run({ ...stored, [at(3)]: undefined as unknown as Obj });
    assert.equal(fallback.deals[0].refsVerified, false);
    assert.equal(fallback.deals[0].sellerOutcome, sellerOutcome);
    assert.equal(fallback.deals[0].anchoredByRole, "buyer");
    assert.equal(fallback.deals[0].bundleContentHash, contentHash(buyer));
    assert.equal(fallback.deals[0].reputationEligible, false);
  }
  // Non-evidence artifacts may carry advisory outcome fields; only the evidence
  // contributes settlement claims, and failed evidence contributes none.
  const annotatedAgreement = { ...agreementScope, outcome: "success" };
  const signedAgreement = { ...annotatedAgreement, signatures: [BUYER, SELLER].map((signer) => ({
    algorithm: "ed25519", signer: dids[signer], value: sign(`dacs-agreement:v1:${contentHash(annotatedAgreement)}`, signer),
  })) };
  const annotatedBundle = { ...bundleScope, agreementRef: { kind: "dacs-3-agreement", id: "agreement-legacy", contentHash: contentHash(annotatedAgreement) } };
  const annotated = await run({ ...base, [resolveProgramAddress(dids[BUYER], `dacs3:agreement:${JOB}`)!]: signedAgreement, ...signedCopies(annotatedBundle) });
  assert.equal(annotated.deals[0].reputationEligible, true);
  assert.equal(annotated.deals[0].settlementTxIds?.length, 1);
  const failedEvidence = { ...evidenceScope, outcome: "failure" };
  const failedBundle = { ...bundleScope, settlementEvidence: [{ kind: "dacs-4-evidence", id: "evidence-legacy", contentHash: contentHash(failedEvidence) }] };
  const failed = await run({ ...base, [evidenceAt]: { ...failedEvidence, signature: { algorithm: "ed25519", signer: dids[SELLER], value: sign(`dacs-evidence:v1:${contentHash(failedEvidence)}`, SELLER) } },
    ...signedCopies({ ...failedBundle, outcome: "failed-counterparty" }, { ...failedBundle, outcome: "failed-perm" }) });
  assert.equal(failed.deals[0].refsVerified, true);
  assert.deepEqual(failed.deals[0].settlementTxIds, []);
  assert.equal(failed.reputation.completed, 0);

  const store = await import("../src/catalog/store.js");
  const priorState = store.loadScanState();
  const vetScope = { jobId: JOB, subject: dids[BUYER], recipeId: "legacy-vet", recipeVersion: "1", decision: "pass", verifiedAt: "2026-10-16T00:00:00Z",
    results: [{ claimRef: dids[BUYER], method: "self-signed", status: "pass", authority: dids[BUYER] }] };
  const vet = { ...vetScope, signature: { algorithm: "ed25519", signer: dids[OUTSIDER], value: sign(`dacs-composite:v1:${contentHash(vetScope)}`, OUTSIDER) } };
  const vettedBundle = { ...bundleScope, vetRecords: [{ kind: "dacs-2-verifyresult", id: "legacy-vet", contentHash: contentHash(vetScope) }] };
  // Match the pinned SDK's session-anchor contract, through an observed cache entry.
  const { sessionAnchorName } = await import("../vendor/dacs-sdk/dist/agent/runSessionCore.js");
  const actualVetName = sessionAnchorName.vet(JOB);
  const vetKey = store.programBindingKey(dids[BUYER], actualVetName);
  try {
    store.saveScanState({ ...priorState, programs: { ...priorState.programs, [vetKey]: at(90) } });
    const complete = { ...base, [at(90)]: vet, ...signedCopies(vettedBundle) };
    assert.equal((await run(complete)).deals[0].refsVerified, true, actualVetName);
    assert.equal((await run({ ...complete, [at(90)]: undefined as unknown as Obj })).deals[0].refsVerified, false);
    store.saveScanState({ ...priorState, programs: { ...priorState.programs, [vetKey]: null } });
    assert.equal((await run(complete)).deals[0].refsVerified, false, "indeterminate program names never fall back");
  } finally { store.saveScanState(priorState); }

  for (const change of [{ phase: "pay-evm-erc20" }, { phaseIndex: -1 }, { phaseIndex: "0" }, { paymentTxRefs: [] },
    { paymentTxRefs: [{ rail: "foreign", txHash: "ab".repeat(32), kind: "payment" }] },
    { paymentTxRefs: [{ rail: "demos", txHash: "ab".repeat(32), kind: "refund" }] }]) {
    const scope = { ...evidenceScope, ...change };
    const paid = { ...scope, signature: { algorithm: "ed25519", signer: dids[SELLER], value: sign(`dacs-evidence:v1:${contentHash(scope)}`, SELLER) } };
    const referenced = { ...bundleScope, settlementEvidence: [{ kind: "dacs-4-evidence", id: "evidence-legacy", contentHash: contentHash(scope) }] };
    const result = await run({ ...base, [evidenceAt]: paid, ...signedCopies(referenced) });
    assert.equal(result.deals[0].reputationEligible, false, JSON.stringify(change));
    assert.deepEqual(result.deals[0].settlementTxIds, [], JSON.stringify(change));
    assert.equal(result.reputation.completed, 0);
  }
});

test("further legacy rules: an invalid presented signature, empty optional lists, unique ids, and the pinned listing content", async () => {
  const value = verification();
  const outsiderEntry = { algorithm: "ed25519", party: dids[OUTSIDER], value: "z" };
  const entries = [{ algorithm: "ed25519", party: dids[BUYER], value: "x" }, { algorithm: "ed25519", party: dids[SELLER], value: "y" }];
  assert.equal(policy.hasRequiredBundleSignatures({ ...value, signatures: [...value.signatures, { party: dids[OUTSIDER], verdict: "invalid" }] },
    { signatures: [...entries, outsiderEntry] }), false, "an invalid presented signature fails the copy");
  const extended = (change: Obj) => verification((bundle) => Object.assign(bundle, change));
  assert.equal(await policy.refsPassStrictPolicy(extended({ ratingRefs: [], amendments: [] }), artifacts()), true);
  assert.equal(await policy.refsPassStrictPolicy(extended({ amendments: "none" }), artifacts()), false);
  // Two evidence refs with one id are ambiguous even when their hashes differ.
  const duplicated = verification((bundle) => { bundle.settlementEvidence = [bundle.settlementEvidence[0], { kind: "dacs-4-evidence", id: "evidence-legacy", contentHash: "e".repeat(64) }]; });
  duplicated.refs = [duplicated.refs[0], duplicated.refs[1], { kind: "dacs-4-evidence", id: "evidence-legacy", verdict: "ok" }, duplicated.refs[2]];
  assert.equal(await policy.refsPassStrictPolicy(duplicated, [artifacts()[0], artifacts()[1], artifacts()[1], artifacts()[2]]), false);
  // Cancellation terms bind to the pinned content, not only to its id and version.
  const terms = { cancellationPolicy: "pre-commit" };
  const pinnedTo = (pinned: Obj, served: Obj) => policy.verifiedListingTerms(
    verification((bundle) => { bundle.listingRef = { listingId: "legacy-svc", version: Number(pinned.listingVersion), contentHash: contentHash(pinned) }; }),
    [{ kind: "dacs-1-listing", raw: { ...served, signature: "verified-by-strict-policy" } }], true);
  assert.equal(pinnedTo({ ...listingScope, terms: { cancellationPolicy: "none" } }, { ...listingScope, terms }), undefined);
  assert.equal(pinnedTo({ ...listingScope, listingVersion: 0, terms }, { ...listingScope, listingVersion: 0, terms }), undefined, "version 0");
});

test("the in-browser verifier: a strict pass, limited without a registered copy, and failure on an altered record", async () => {
  const { detailRows, verdictPresentation, verificationErrorMessage, verifyDealInBrowser } = await import("../src/components/verifyDealModel.js");
  const bundleScope: Obj = { ...verification().bundle } as Obj;
  delete bundleScope.anchoredByRole;
  const signature = (signer: number) => ({ party: dids[signer], algorithm: "ed25519", value: sign(`dacs-bundle:v1:${contentHash(bundleScope)}`, signer, "base64url") });
  const stored = new Map<string, Obj>([
    [at(1), listing], [at(2), { ...bundleScope, signatures: [signature(BUYER), signature(SELLER)], anchoredByRole: "buyer" }],
    [`dacs3:agreement:${JOB}`, agreement], [`dacs4:evidence:${JOB}`, evidence],
  ]);
  const requested: string[] = [];
  const deps = (registered: { owners: unknown; buyerBundleRef: unknown; sellerBundleRef: unknown } | null, from = stored) => ({
    fetchArtifact: async (params: string) => {
      requested.push(params);
      const query = new URLSearchParams(params);
      return from.get(query.get("ref") ?? query.get("name") ?? "") ?? null;
    },
    registeredBundleRefs: async () => registered,
  });
  const registered = { owners: { buyer: dids[BUYER], seller: dids[SELLER] }, buyerBundleRef: at(2), sellerBundleRef: at(3) };
  const input = { bundleRef: at(2), buyerOwner: dids[BUYER], expectedSeller: dids[SELLER] };

  const strict = await verifyDealInBrowser(input, deps(registered));
  assert.equal(strict.verdict, "strict-pass");
  const shown = verdictPresentation(strict.result, strict.verdict);
  assert.deepEqual([shown.tone, shown.headline, shown.checks.map((check) => check.mark)], ["ok", "✓ Evidence is strictly verified", ["✓", "✓", "✓"]]);
  // Session artifacts are read from the buyer's owner-scoped programs, by name; the bundle by its ref.
  assert.ok(requested.includes(`owner=${encodeURIComponent(dids[BUYER])}&name=${encodeURIComponent(`dacs3:agreement:${JOB}`)}`));
  assert.ok(requested.includes(`ref=${encodeURIComponent(at(2))}`));
  const rows = detailRows(strict.result);
  assert.deepEqual(rows.signatures.map((row) => [row.title, row.badge]), [["The buyer’s", "genuine ✓"], ["The seller’s", "genuine ✓"]]);
  assert.ok(rows.refs.length > 0 && rows.refs.every((row) => row.ok && row.badge === "untampered ✓"));

  const limited = await verifyDealInBrowser(input, deps(null));
  assert.equal(limited.verdict, "limited");
  const limitedShown = verdictPresentation(limited.result, limited.verdict);
  assert.deepEqual([limitedShown.tone, limitedShown.headline, limitedShown.checks.map((check) => check.mark)],
    ["limited", "◇ Evidence is internally consistent; copy role unverified", ["✓", "✓", "?"]]);

  const altered = new Map(stored).set(`dacs4:evidence:${JOB}`, { ...evidence, observedAt: 101 });
  const failed = await verifyDealInBrowser(input, deps(registered, altered));
  assert.equal(failed.verdict, "fail");
  const failedShown = verdictPresentation(failed.result, failed.verdict);
  assert.deepEqual([failedShown.tone, failedShown.headline, failedShown.checks[1].mark, failedShown.checks[2].mark],
    ["err", "✗ Evidence failed verification", "✗", "✗"]);
  assert.ok(detailRows(failed.result).refs.some((row) => !row.ok && row.badge === "problem ✗"));
  // A strict pass is never shown for a result the policy failed.
  assert.equal(verdictPresentation({ ...strict.result, ok: false }, "fail").tone, "err");

  assert.match(verificationErrorMessage(new TypeError("fetch failed")), /could not be reached/);
  assert.equal(verificationErrorMessage(new Error("unsupported artifact")), "unsupported artifact");
});
