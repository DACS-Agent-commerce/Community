import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { canonicalDemosAgentClaim } from "../src/catalog/claimRef.js";
import { resolveBundleSide, logicalBundleAddress } from "../src/catalog/bundleBinding.js";
import { currentBundleCopiesDiverge } from "../src/catalog/currentReconciliation.js";
import {
  agreementListingConformance,
  agreementMatchesListing,
  COMMITTED_AT_INDETERMINATE,
  faultAttributionOk,
} from "../src/catalog/evidenceGraph.js";
import { admitSettlement, settlementTxId } from "../src/catalog/settlementKey.js";
import { verifyListing } from "../src/catalog/listingVerification.js";
import type { ResolvePrimaryClaimKey } from "../src/catalog/primaryClaimKey.js";

// Upstream DACS-Standard conformance vectors (SPEC_PIN) run through adapters onto the Directory's own
// decision functions. A vector set is often a projection of the full artifacts; each adapter maps the
// projection onto the Directory's input shape and nothing else. A case the Directory does not decide
// is listed with its reason, and a deliberate deviation is pinned with the Directory's own verdict.
type Obj = Record<string, unknown>;
const fixture = (name: string) => new URL(`./fixtures/dacs-standard/${name}`, import.meta.url);
const load = <T>(name: string) => JSON.parse(readFileSync(fixture(name), "utf8")) as T;
const pinned = readFileSync(new URL("../SPEC_PIN", import.meta.url), "utf8");
const VENDORED = [
  "unresolved-vs-absent-v0.3.json", "bundle-absence-evidence-v0.3.json",
  "signature-value-encoding-v0.1.json", "revocation-binding-v0.3.json", "sb2-settlement-uniqueness-v0.1.json",
  "agreement-listing-v0.1.json", "mixed-version-reconciliation-v0.3.json", "fault-bundle-perspective-pair-v0.3.json",
  "payee-destination-binding-v0.1.json", "demos-agent-claim-reference.json", "listing-preserve-unknown-v0.1.json",
];

test("every vendored Standard file is the byte-identical copy SPEC_PIN records", () => {
  for (const name of VENDORED) {
    const digest = createHash("sha256").update(readFileSync(fixture(name))).digest("hex");
    assert.match(pinned, new RegExp(`${name.replace(/[.]/g, "\\.")}\\s+${digest}`), name);
  }
});

test("SB-1/SB-2 sb2-settlement-uniqueness-v0.1: canonical keys, collapse, error and the (jobId, phaseIndex) ledger", () => {
  interface Vector { name: string; decision: string; effect: string; consumed: Record<string, { jobId: string; phaseIndex: number }> | null; record: Obj }
  const set = load<{ vectors: Vector[] }>("sb2-settlement-uniqueness-v0.1.json");
  // The projection names the rail; the ChainTxRef discriminator is `kind`, and demos-native is `demos`.
  const asChainTxRef = (ref: Obj | undefined) => ref && { ...ref, kind: ref.rail === "demos-native" ? "demos" : ref.rail };
  // The Directory keeps its own in-memory ledger per derivation, so it is never unreadable.
  const notDecided = new Set(["ledger-unreadable-indeterminate"]);
  assert.equal(set.vectors.length, 20);
  for (const vector of set.vectors) {
    if (notDecided.has(vector.name)) continue;
    const id = settlementTxId(asChainTxRef(vector.record.settlementRef as Obj | undefined));
    // phaseIndex is the bundle entry's index, which the bundle shape holds to a safe integer ≥ 0.
    const phaseIndex = vector.record.phaseIndex;
    if (!id || !Number.isSafeInteger(phaseIndex) || Number(phaseIndex) < 0) {
      assert.equal(vector.decision, "error", vector.name);
      continue;
    }
    const ledger = new Map(Object.entries(vector.consumed ?? {}));
    const effect = admitSettlement(ledger, { id, jobId: String(vector.record.jobId), phaseIndex: Number(phaseIndex) });
    assert.equal(effect, vector.effect, vector.name);
  }
});

test("DACS-3 §8.5.2 agreement-listing-v0.1 through agreementListingConformance", () => {
  interface Vector { name: string; expected: "accept" | "reject" | "indeterminate"; committedAt: number | null; agreement: Obj; listing: Obj }
  const set = load<{ vectors: Vector[] }>("agreement-listing-v0.1.json");
  const PUBLISHER = `did:demos:agent:${"5".repeat(64)}`;
  // CORE CD-1 canonical amount; the Directory compares canonical amounts and rejects any other spelling.
  const cd1 = (amount: unknown) => String(amount).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  const price = (term: Obj) => ({ ...term, amount: cd1(term.amount) });
  const PATTERN_STEP: Record<string, Obj> = {
    // The projection names the pattern only; an RFQ step admits its fixed-price fallback (PS-3).
    rfq: { kind: "negotiate-rfq", parameters: { maxTurns: 4, timeoutSec: 60, fixedPriceFallback: true } },
    "fixed-price": { kind: "negotiate-fixed-price" },
  };
  const adapt = (vector: Vector) => {
    const projected = vector.listing;
    const pricing = projected.pricing as Obj;
    const spec: Obj = { kind: (projected.offering as { deliverable: Obj }).deliverable.deliverableType };
    const schemaUrl = (projected.offering as { deliverable: Obj }).deliverable.schemaUrl;
    if (schemaUrl !== undefined) spec.schemaUrl = schemaUrl;
    const rails = projected.acceptedRails as string[];
    const listing: Obj = {
      listingId: projected.listingId, listingVersion: projected.version,
      pricing: pricing.kind === "fixed" ? { kind: "fixed", price: price({ amount: pricing.amount, currency: pricing.currency }) }
        : { ...pricing, bandCenter: price(pricing.bandCenter as Obj) },
      pipeline: [PATTERN_STEP[String(projected.pattern)], { kind: "commit-agreement" },
        ...(projected.hasPayPhase ? [{ kind: rails[0], parameters: { rail: rails[0] } }] : []), { kind: "deliver-attested-payload" }],
      acceptedRails: rails.map((railId) => ({ railId })), offering: { deliverable: spec }, terms: projected.terms, validity: projected.validity,
    };
    const terms = vector.agreement.terms as Obj;
    const deliverable = terms.deliverable as Obj;
    const agreement: Obj = {
      agreementVersion: "1", derivedFromPattern: vector.agreement.derivedFromPattern,
      parties: [{ role: "buyer", primaryClaim: `did:demos:agent:${"6".repeat(64)}` }, { role: "seller", primaryClaim: PUBLISHER }],
      terms: { ...terms, price: price(terms.price as Obj), deliverable: {
        ...deliverable,
        // The projection hashes the spec opaquely: an unchanged hash is the listed spec's DeliverableRef hash.
        hash: deliverable.hash === (projected.offering as { deliverable: Obj }).deliverable.hash ? contentHash(spec) : deliverable.hash,
      } },
    };
    // The agreement pins the listing by (listingId, version, contentHash); the graph rejects any other pin.
    const pin = vector.agreement.listingRef as Obj;
    const pinOk = pin.listingId === projected.listingId && pin.version === projected.version && pin.contentHash === projected.contentHash;
    return { listing, agreement, pinOk };
  };
  // DACS-Standard text vs vector: §8.5.2 rounds bounds to the CD-1 digits of bandCenter ("100" has none),
  // so 100 × 1.025 rounds to 103 and "103.00" is in band. The Directory follows the text.
  const deviations: Record<string, string> = { "fractional-pct-out": "accept" };
  assert.equal(set.vectors.length, 30);
  for (const vector of set.vectors) {
    const { listing, agreement, pinOk } = adapt(vector);
    const result = pinOk ? agreementListingConformance(agreement, listing, PUBLISHER, vector.committedAt) : "listing-binding";
    const verdict = result === null ? "accept" : result === COMMITTED_AT_INDETERMINATE ? "indeterminate" : "reject";
    assert.equal(verdict, deviations[vector.name] ?? vector.expected, `${vector.name}: ${result}`);
  }
  // Without the CD-1 step the Directory rejects a non-canonical amount outright (fail-closed) rather than canonicalising.
  const valid = adapt(set.vectors.find((vector) => vector.name === "valid-in-band-rfq")!);
  const raw = { ...valid.agreement, terms: { ...(valid.agreement.terms as Obj), price: { currency: "USDC", amount: "95.00" } } };
  assert.equal(agreementListingConformance(raw, valid.listing, PUBLISHER, 1780000000000), "terms");
});

test("DACS-5 §10.4.3 mixed-version-reconciliation-v0.3 and fault-bundle-perspective-pair-v0.3", () => {
  interface Vector { name: string; expected: "pass" | "fail"; copies: { buyer?: Obj; seller?: Obj } }
  const sets = [load<{ vectors: Vector[] }>("mixed-version-reconciliation-v0.3.json"), load<{ vectors: Vector[] }>("fault-bundle-perspective-pair-v0.3.json")];
  const decide = (copies: Vector["copies"]) => {
    const present = [copies.buyer, copies.seller].filter((copy): copy is Obj => Boolean(copy));
    // Each copy first passes the §10.4.1 permissible-set check the graph applies; a pair then must not diverge.
    if (!present.every((copy) => faultAttributionOk(copy, copy.parties as Obj[]))) return "fail";
    return copies.buyer && copies.seller && currentBundleCopiesDiverge(copies.buyer, copies.seller) ? "fail" : "pass";
  };
  for (const set of sets) for (const vector of set.vectors) assert.equal(decide(vector.copies), vector.expected, vector.name);
});

test("DACS-3 §8.5 payee-destination-binding-v0.1: artifact type and PB-1 payout coverage", () => {
  interface Vector { name: string; op: string; expected: string; readerMode?: string; commitPhase?: string; listing?: Obj; agreement?: Obj; want?: Obj }
  const set = load<{ vectors: Vector[] }>("payee-destination-binding-v0.1.json");
  // The Directory reads current artifacts after the fact: it decides the artifact type against the pinned
  // commitment phase and PB-1 coverage. It is not a legacy reader, verifies signatures over its own
  // did:demos:agent claims (not these cci-lei keys), and never runs the payer's PB-2/PB-3 pre-pay gate.
  const decided = new Set([
    "agreement-current-reader-accepts-legacy-no-pb", "agreement-current-reader-accepts-payee-bound",
    "agreement-legacy-payoutbindings-reject", "agreement-both-discriminators-reject", "agreement-neither-discriminator-reject",
    "agreement-payee-bound-omitted-payoutbindings-reject", "agreement-commit-agreement-with-payee-bound-rejects",
    "agreement-commit-payee-bound-with-legacy-rejects", "pb1-agreement-bound-destination-matches", "pb1-missing-payoutbinding-permanent",
    "pb1-duplicate-payoutbinding-permanent", "pb1-wrong-rail-payoutbinding-permanent", "pb1-extra-payoutbinding-permanent",
    "pb1-repeated-pay-phases-distinct-bindings",
  ]);
  let run = 0;
  for (const vector of set.vectors) {
    if (!decided.has(vector.name)) continue;
    run++;
    const pipeline = vector.listing!.pipeline as Obj[];
    // The commitment phase the vector names is the one its listing pins.
    const listing = { ...vector.listing, pipeline: pipeline.map((step) =>
      step.kind === "commit-agreement" || step.kind === "commit-payee-bound-agreement" ? { kind: vector.commitPhase ?? step.kind } : step) };
    assert.equal(agreementMatchesListing(vector.agreement!, listing) ? "pass" : "fail", vector.expected, vector.name);
  }
  assert.equal(run, decided.size);
});

test("SIG-5 listing-preserve-unknown-v0.1 through verifyListing", async () => {
  interface Vector { name: string; fixture: string; transform: { kind: "none" | "set" | "remove"; path?: string; value?: unknown }; expected: "pass" | "fail" }
  const set = load<{ publicKeys: Record<string, string>; fixtures: Record<string, { listing: Obj }>; vectors: Vector[] }>("listing-preserve-unknown-v0.1.json");
  const keys: ResolvePrimaryClaimKey = async (claim, algorithm) => set.publicKeys[claim] && algorithm === "ed25519"
    ? { canonicalClaim: claim, algorithm, publicKey: Uint8Array.from(Buffer.from(set.publicKeys[claim], "base64url")) } : null;
  assert.equal(set.vectors.length, 4);
  for (const vector of set.vectors) {
    const listing = structuredClone(set.fixtures[vector.fixture].listing);
    if (vector.transform.kind !== "none") {
      const path = vector.transform.path!.split(".");
      const parent = path.slice(0, -1).reduce((value, key) => value[key] as Obj, listing);
      if (vector.transform.kind === "set") parent[path.at(-1)!] = vector.transform.value;
      else delete parent[path.at(-1)!];
    }
    // An unknown phase kind is refused even under a valid signature (§11.1.2), as is any altered signed field.
    assert.equal(await verifyListing(listing, keys) ? "pass" : "fail", vector.expected, vector.name);
  }
});

test("did:demos:agent ClaimReference profile fixture (DACS-Standard #296 at 725fa78)", () => {
  const set = load<{ cases: Array<{ id: string; input: string; expected: { accepted: boolean; canonical: string | null } }> }>("demos-agent-claim-reference.json");
  assert.equal(set.cases.length, 4);
  for (const entry of set.cases) assert.equal(canonicalDemosAgentClaim(entry.input), entry.expected.canonical, entry.id);
});

test("BB-8 absence vectors distinguish missing discovery, unqualified reads and divergent content", async () => {
  const seller = `did:demos:agent:${"6".repeat(64)}`;
  const deviations = new Set(["binding-resolves-authoritative-absent-one-sided", "binding-qualified-absence-allows-one-sided"]);
  let count = 0;
  for (const name of ["unresolved-vs-absent-v0.3.json", "bundle-absence-evidence-v0.3.json"]) {
    const set = load<{ vectors: Array<{ name: string; expected: string; binding: Obj; reads?: Record<string, Obj>; variants?: Obj[] }> }>(name);
    assert.equal(set.vectors.length, 4);
    for (const vector of set.vectors) {
      const evaluate = async (reads: Record<string, Obj>) => {
        const content = (read: Obj | undefined): Obj | undefined => read?.response === "content" ? read.bundle as Obj
          : (read?.observations as Obj[] | undefined)?.find((view) => view.response === "content")?.bundle as Obj | undefined;
        const buyer = content(reads.buyer);
        const sellerCopy = content(reads.seller);
        if (buyer && sellerCopy) return currentBundleCopiesDiverge(
          { ...buyer, phaseSummary: [] }, { ...sellerCopy, phaseSummary: [] },
        ) ? "fail" : "pass";
        const binding = { bindingVersion: "1" as const, jobId: "vector-job", role: "seller" as const,
          logicalAddress: logicalBundleAddress("vector-job", "seller"), nativeAddress: `stor-${"0".repeat(40)}`,
          bundleContentHash: "a".repeat(64), signer: seller,
          signature: { algorithm: "ed25519" as const, signer: seller, value: "" } };
        // Only project discovered bindings; missing/unauthenticated/policy-qualified absence all
        // stay unresolved on Demos, whose mapping has no absence-evidence policy (SPEC_PIN).
        const resolution = await resolveBundleSide({ jobId: "vector-job", role: "seller", expectedSigner: seller,
          bindings: vector.binding.resolved === false ? [] : [binding], inspect: async () => null });
        return resolution.disposition;
      };
      const expected = deviations.has(vector.name) ? "indeterminate" : vector.expected;
      assert.equal(await evaluate(vector.reads ?? {}), expected, vector.name);
      for (const variant of vector.variants ?? []) {
        assert.equal(await evaluate({ seller: variant.missingAddressRead as Obj }), "indeterminate", `${vector.name}/${variant.name}`);
      }
      count++;
    }
  }
  assert.equal(count, 8);
  assert.equal(deviations.size, 2);
});
