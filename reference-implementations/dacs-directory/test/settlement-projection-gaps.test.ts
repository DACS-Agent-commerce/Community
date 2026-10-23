import assert from "node:assert/strict";
import test from "node:test";
// First: the store must open in a fresh directory, never the checkout's data/.
import "./fixtures/isolated-data-dir.js";
import { isChainTxRef, isSettlementEvidence } from "@kynesyslabs/dacs/artifacts";
import { paymentEvidenceAddress } from "@kynesyslabs/dacs/canonical";
import { buildCurrentEvidenceGraph, signedScope } from "../src/catalog/evidenceGraph.js";
import { indexRegistration } from "../src/catalog/indexer.js";
import { deriveSellerReputation } from "../src/catalog/reputation.js";
import {
  countableDeals, isCanonicalSettlementTxId, settlementClaims, settlementTxId, SETTLEMENT_PROJECTION_VERSION,
} from "../src/catalog/settlementUniqueness.js";
import { observedOutcomesLabel, projectTestnetCatalog, rebuildCatalogObservations } from "../src/catalog/testnetMetrics.js";
import type { DealRecord, ListingSummary, ReputationHint, SellerRecord } from "../src/catalog/types.js";
import { isCanonicalSettlementIdentity } from "../vendor/dacs-sdk/dist/agent/settlementIdentity.js";
import { type Obj, bindingFor, dids, evidenceAddresses, locator, maps, ref, registeredDeal, sign, vector } from "./fixtures/current-evidence.js";

const hash = "ab".repeat(32);
const signature64 = "99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3BbeqPevr5E1iCbpTjqHuTFLtfxTTD5ekfVuZFzQyEQf8";
// Base58 of 64 bytes at the top of the 88-character range: no leading zero digit, 87 zero digits after the first.
const signature88 = `2${"1".repeat(87)}`;

const x402Ref = { kind: "x402-event", chainId: 8453, settlementTxHash: hash, logIndex: 0,
  httpResource: "https://seller.example/pay", paymentReceiptHash: "cd".repeat(32), protocolVersion: "2" };
const arms: Record<string, Obj> = {
  demos: { kind: "demos", txHash: hash },
  evm: { kind: "evm-event", chainId: 8453, txHash: hash, logIndex: 0 },
  x402: x402Ref,
  solana: { kind: "solana-instruction", cluster: "mainnet", signature: signature64, instructionIndex: 0 },
};
// handler, registry rail, and the one TxRef arm that rail's payment is made of.
const rails: Array<[string, string, string]> = [
  ["pay-dem", "demos-native:DEM", "demos"], ["pay-evm-erc20", "evm-erc20:8453:USDC", "evm"],
  ["pay-solana-spl", "solana-spl:mainnet:USDC", "solana"], ["pay-x402", "x402:default", "x402"],
];

test("SB-1 current Demos TxRefs refuse a prefix or suffix around a valid hash", () => {
  assert.equal(settlementTxId(arms.demos), `demos:${hash}`);
  for (const txHash of [`x${hash}`, `${hash}x`]) {
    const currentRef = { kind: "demos", txHash };
    assert.equal(isChainTxRef(currentRef), true, "the SDK admits the current arm structurally");
    assert.equal(settlementTxId(currentRef), null, txHash);
  }
});

test("SB-1 current Solana TxRefs refuse an invalid Base58 digit in a full-length signature", () => {
  assert.equal(settlementTxId(arms.solana), `solana:mainnet:${signature64}:0`);
  // Keeping the decoded magnitude isolates alphabet validation from the 64-byte size check.
  const signature = `${signature64.slice(0, -1)}0`;
  assert.equal(signature.length, signature64.length);
  const currentRef = { ...arms.solana, signature };
  assert.equal(isChainTxRef(currentRef), true, "the SDK admits a nonempty signature structurally");
  assert.equal(settlementTxId(currentRef), null);
});

test("SB-1/SB-2 stored settlement ids: exact type, anchoring and decimal indices, as the pinned SDK validates them", () => {
  const canonical = [`demos:${hash}`, `evm:8453:${hash}:3`, `solana:mainnet:${signature64}:2`];
  for (const id of [...canonical, `evm:8453:${hash}:12`, `evm:10:${hash}:0`, `solana:devnet:${signature64}:12`,
    `solana:testnet:${signature64}:1234567890`, `solana:mainnet:${signature88}:0`]) {
    assert.ok(isCanonicalSettlementIdentity(id), `the pinned SDK accepts ${id}`);
    assert.equal(isCanonicalSettlementTxId(id), true, id);
  }
  const malformed: unknown[] = [
    // A non-string that coerces to a canonical id.
    ...canonical.map((id) => [id]), ...canonical.map((id) => ({ toString: () => id })),
    // A prefix or suffix outside the anchored spelling.
    ...canonical.map((id) => `x${id}`), ...canonical.map((id) => `${id}x`), ...canonical.map((id) => `${id}\n`),
    // A decimal-only index.
    `evm:8453:${hash}:1e2`, `evm:8453:${hash}:0x10`, `evm:8453:${hash}:1.0`, `evm:8453:${hash}:-1`, `evm:8453:${hash}:012`,
    `solana:mainnet:${signature64}:1e2`, `solana:mainnet:${signature64}:0x10`, `solana:mainnet:${signature64}:1.0`,
    `solana:mainnet:${signature64}:012`,
    // A chain id that is not a canonical positive decimal.
    `evm:1e3:${hash}:0`, `evm:8453x:${hash}:0`,
  ];
  for (const id of malformed) {
    assert.equal(isCanonicalSettlementTxId(id), false, JSON.stringify(id) ?? String(id));
    if (typeof id === "string") assert.equal(isCanonicalSettlementIdentity(id), false, `the pinned SDK refuses ${id}`);
  }
});

test("SB-1 spells a valid 88-character Solana signature and SB-2 admits it, but not 89 characters", () => {
  assert.equal(signature88.length, 88);
  const id = `solana:mainnet:${signature88}:0`;
  assert.ok(isCanonicalSettlementIdentity(id));
  assert.equal(settlementTxId({ kind: "solana-instruction", cluster: "mainnet", signature: signature88, instructionIndex: 0 }), id);
  assert.equal(isCanonicalSettlementTxId(id), true);
  assert.equal(settlementTxId({ kind: "solana-instruction", cluster: "mainnet", signature: `1${signature88}`, instructionIndex: 0 }), null);
  assert.equal(isCanonicalSettlementTxId(`solana:mainnet:1${signature88}:0`), false);
});

test("SB-1 refuses oversized SDK-readable Solana signatures before Base58 decoding", () => {
  const oversized = "z".repeat(4096);
  const ref = { kind: "solana-instruction", cluster: "mainnet", signature: oversized, instructionIndex: 0 };
  assert.equal(isChainTxRef(ref), true, "the SDK admits the oversized signature structurally");
  const originalIterator = String.prototype[Symbol.iterator];
  let oversizedIterations = 0;
  let allowedIterations = 0;
  String.prototype[Symbol.iterator] = function () {
    if (this.valueOf() === oversized) oversizedIterations++;
    if (this.valueOf() === signature88) allowedIterations++;
    return originalIterator.call(this);
  };
  try {
    assert.equal(settlementTxId(ref), null);
    assert.equal(isCanonicalSettlementTxId(`solana:mainnet:${oversized}:0`), false);
    assert.equal(oversizedIterations, 0, "oversized input must never enter the decoder");
    assert.equal(settlementTxId({ ...ref, signature: signature88 }), `solana:mainnet:${signature88}:0`);
    assert.ok(allowedIterations > 0, "the instrumentation observes decoding of an allowed signature");
  } finally {
    String.prototype[Symbol.iterator] = originalIterator;
  }
});

test("TP-1 requires evidence for recorded ok payment phases without claiming full execution verification", () => {
  const context = {
    jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D", railId: "demos-native:DEM", railRegistryVersion: 1,
    pipeline: [{ kind: "commit-agreement" }, { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }],
  };
  const commit = { index: 0, kind: "commit-agreement", outcome: "ok" };
  assert.deepEqual(settlementClaims([], { ...context, phaseSummary: [commit, { index: 1, kind: "pay-dem", outcome: "ok" }] }),
    { settlementTxIds: [], projected: false }, "a recorded successful payment needs evidence");
  for (const phaseSummary of [[], [commit], [commit, { index: 1, kind: "pay-dem", outcome: "fail" }]]) {
    assert.deepEqual(settlementClaims([], { ...context, phaseSummary }), { settlementTxIds: [], projected: true },
      "summary completeness and execution success are outside the current observation profile");
  }
});

const deal = (jobId: string, values: Partial<DealRecord> = {}): DealRecord => ({
  jobId, rail: "pay-dem", buyerBundleRef: locator(300), sellerBundleRef: locator(301),
  owners: { buyer: dids[0], seller: dids[1] }, signatureVerified: true, refsVerified: true, reputationEligible: true,
  settlementProjectionVersion: SETTLEMENT_PROJECTION_VERSION, sellerOutcome: "completed", finalisedAt: 100, anchorTimestamp: 100,
  verifiedAt: 1, bundleContentHash: jobId.repeat(64).slice(0, 64), category: "services.test",
  agreementPrice: { amount: "1", currency: "DEM" },
  settlementTxIds: [{ id: `demos:${hash}`, observedAt: 10, phaseIndex: 2 }], ...values,
});

const seller = (deals: DealRecord[], extra: Partial<SellerRecord> = {}, listing: Partial<ListingSummary> = {}): SellerRecord => ({
  primaryClaim: dids[1], displayName: "gaps", cci: [], registeredAt: 1, lastIndexedAt: 1, deals,
  listings: [{ listingId: "gaps", version: 1, offering: { category: "services.test" }, ...listing } as unknown as ListingSummary],
  ...extra,
} as unknown as SellerRecord);
const catalogOf = (sellers: SellerRecord[], generatedAt = 200) => ({ catalogVersion: "1" as const, generatedAt, sellers });
const hintOf = (record: SellerRecord, generatedAt = 200): ReputationHint =>
  rebuildCatalogObservations(catalogOf([record], generatedAt)).sellers[0].listings[0].reputationHint!;

test("SB-2 stored ids that are not the exact canonical spelling neither count nor void a valid deal", () => {
  const prefixed = [`xdemos:${hash}`, `xevm:8453:${hash}:3`, `xsolana:mainnet:${signature64}:2`];
  for (const [index, id] of [`demos:${hash}`, `evm:8453:${hash}:3`, `solana:mainnet:${signature64}:2`].entries()) {
    const valid = deal("a", { settlementTxIds: [{ id, observedAt: 10, phaseIndex: 2 }] });
    for (const stored of [prefixed[index], [id], `${id}x`, `${id.slice(0, -1)}1e2`]) {
      const competitor = deal("b", { settlementTxIds: [{ id: stored as unknown as string, observedAt: 10, phaseIndex: 2 }] });
      const projected = deriveSellerReputation([valid, competitor], 0, 200);
      assert.deepEqual(projected.bundleRefs?.map((entry) => entry.id), ["a"], JSON.stringify(stored));
    }
  }
  // The same ids with indices of more than one digit still group, so a real collision still voids.
  for (const id of [`evm:8453:${hash}:12`, `solana:mainnet:${signature64}:12`]) {
    const out = deriveSellerReputation([deal("a", { settlementTxIds: [{ id, observedAt: 10, phaseIndex: 2 }] }),
      deal("b", { settlementTxIds: [{ id, observedAt: 10, phaseIndex: 2 }] })], 0, 200);
    assert.equal(out.bundleCount, 0, id);
  }
});

test("SB-2 groups an admissible deal only against other admissible deals", () => {
  const valid = deal("a");
  const other = (values: Partial<DealRecord>) => deal("b", values);
  const inadmissible: Array<[string, Partial<DealRecord>]> = [
    ["refs not verified", { refsVerified: false }],
    ["not reputation eligible", { reputationEligible: false }],
    ["an invalid outcome", { sellerOutcome: "bogus" as DealRecord["sellerOutcome"] }],
    ["no outcome", { sellerOutcome: undefined }],
    ["a malformed stored id elsewhere in the record", { settlementTxIds: [
      { id: `demos:${hash}`, observedAt: 10, phaseIndex: 2 }, { id: "tx", observedAt: 10, phaseIndex: 3 }] }],
  ];
  for (const [name, values] of inadmissible) {
    for (const order of [[valid, other(values)], [other(values), valid]]) {
      const direct = deriveSellerReputation(order, 0, 200);
      assert.deepEqual(direct.bundleRefs?.map((entry) => entry.id), ["a"], name);
      const record = rebuildCatalogObservations(catalogOf([seller(order)])).sellers[0];
      assert.equal(record.reputation.bundleCount, 1, name);
      assert.equal(record.listings[0].reputationHint!.bundleCount, 1, name);
    }
  }
  // A record cached by an older projection is not eligible, so it cannot void the current claim either.
  const old = other({ settlementProjectionVersion: SETTLEMENT_PROJECTION_VERSION - 1 });
  for (const result of [rebuildCatalogObservations(catalogOf([seller([valid, old])])), projectTestnetCatalog(catalogOf([seller([valid, old])]))]) {
    assert.equal(result.sellers[0].reputation.bundleCount, 1);
    assert.equal(result.sellers[0].listings[0].reputationHint!.bundleCount, 1);
  }
  // The control: an eligible competitor under another session does void the shared settlement.
  assert.equal(deriveSellerReputation([valid, other({})], 0, 200).bundleCount, 0);
});

test("SB-2 missing or null cached owners retain non-throwing, idempotent session grouping", () => {
  for (const state of ["missing", "null"] as const) {
    const cached = deal("a");
    if (state === "missing") delete (cached as { owners?: DealRecord["owners"] }).owners;
    else (cached as unknown as { owners: null }).owners = null;
    const copies = [cached, { ...cached }];
    assert.deepEqual(countableDeals(copies, 0, 200), { deals: [cached], withheldDeals: [copies[1]], useAnchorTimestamps: true }, state);
    const projected = projectTestnetCatalog(catalogOf([seller(copies)])).sellers[0];
    assert.deepEqual(projected.deals, copies, `${state}: cached evidence is retained`);
    assert.equal(projected.reputation.bundleCount, 1, state);
    assert.deepEqual(projected.reputation.bundleRefs?.map((entry) => entry.id), ["a"], state);
    assert.equal(projected.listings[0].reputationHint!.bundleCount, 1, state);
  }
});

test("DACS-5 window membership is inclusive on both edges for either timestamp basis and ignores string timestamps", () => {
  const timestamps = [99, 100, 150, 200, 201];
  const ids = (deals: DealRecord[]) => deriveSellerReputation(deals, 100, 200).bundleRefs!.map((entry) => entry.id).sort();
  const inWindow = ["b", "c", "d"];
  assert.deepEqual(ids(timestamps.map((at, index) => deal("abcde"[index], { anchorTimestamp: at, finalisedAt: 150, settlementTxIds: [] }))), inWindow);
  assert.deepEqual(countableDeals(timestamps.map((at, index) => deal("abcde"[index], { anchorTimestamp: at, settlementTxIds: [] })), 100, 200)
    .useAnchorTimestamps, true);
  const finalised = timestamps.map((at, index) => deal("abcde"[index], { anchorTimestamp: undefined, finalisedAt: at, settlementTxIds: [] }));
  assert.deepEqual(ids(finalised), inWindow);
  assert.equal(countableDeals(finalised, 100, 200).useAnchorTimestamps, false);
  // A string is never a timestamp, even one that compares inside the window.
  const strings = [deal("a", { anchorTimestamp: undefined, finalisedAt: "150" as unknown as number, settlementTxIds: [] }),
    deal("b", { anchorTimestamp: "150" as unknown as number, finalisedAt: 150, settlementTxIds: [] })];
  assert.deepEqual(ids(strings), ["b"], "one string anchor time falls the whole set back to finalisedAt");
  assert.deepEqual(ids([strings[0]]), []);
});

test("observed-outcome labels cover an unknown count", () => {
  assert.equal(observedOutcomesLabel(undefined), "Observed outcomes unavailable, not verified");
  assert.equal(observedOutcomesLabel(0), "Observed outcomes: 0, not verified");
  assert.equal(observedOutcomesLabel(3), "Observed outcomes: 3, not verified");
});

const projectionFixture = async (offset: number) => {
  const fixture = await vector("01KTY8ZJ11CW7KSECW3FS6PQPK", offset);
  const jobId = String(fixture.evidence.jobId);
  const context = (railId = "demos-native:DEM", handler = "pay-dem", phaseSummary: unknown = [{ index: 2, kind: handler, outcome: "ok" }],
    pipeline: unknown = [{}, {}, { kind: handler, parameters: { rail: railId } }]) =>
    ({ jobId, railId, railRegistryVersion: 1, phaseSummary, pipeline });
  const address = (index: number, railId = "demos-native:DEM") => paymentEvidenceAddress(jobId, railId, index);
  return { fixture, jobId, context, address };
};

test("SB-1 matches each pinned rail only to its own TxRef arm", async () => {
  const { fixture, context, address } = await projectionFixture(8100);
  for (const [handler, railId, own] of rails) {
    for (const [name, txRef] of Object.entries(arms)) {
      const raw = { ...fixture.evidence, phase: handler, paymentTxRefs: [txRef] };
      assert.equal(isSettlementEvidence(raw), true, `${name} under ${handler} is SDK-valid evidence`);
      const claims = settlementClaims([{ raw, logicalAddress: address(2, railId) }], context(railId, handler));
      assert.equal(claims.projected, name === own, `${name} ref under ${handler}`);
      assert.equal(claims.settlementTxIds.length, 1, `${name} ref under ${handler}: only a spelled id is reported`);
    }
  }
  // Another chain or cluster than the one the rail names stays refused.
  const evm = { ...fixture.evidence, phase: "pay-evm-erc20", paymentTxRefs: [{ ...arms.evm, chainId: 1 }] };
  assert.equal(settlementClaims([{ raw: evm, logicalAddress: address(2, "evm-erc20:8453:USDC") }], context("evm-erc20:8453:USDC", "pay-evm-erc20")).projected, false);
});

test("SB-1 reports only a projectable id for each TxRef and refuses the deal for the rest", async () => {
  const { fixture, context, address } = await projectionFixture(8200);
  const legacy = { kind: "evm", chainId: 1, txHash: hash };
  const raw = { ...fixture.evidence, paymentTxRefs: [arms.demos, legacy] };
  assert.equal(isSettlementEvidence(raw), true, "the legacy evm arm is SDK-valid");
  assert.deepEqual(settlementClaims([{ raw, logicalAddress: address(2) }], context()), {
    settlementTxIds: [{ id: `demos:${hash}`, observedAt: 100, phaseIndex: 2 }], projected: false });
  const only = { ...fixture.evidence, paymentTxRefs: [legacy] };
  assert.deepEqual(settlementClaims([{ raw: only, logicalAddress: address(2) }], context()), { settlementTxIds: [], projected: false });
});

test("SB-1 claims come from success evidence only; failure evidence beside a failed payment phase is ignored", async () => {
  const { fixture, context, address } = await projectionFixture(8300);
  const failure = { evidenceVersion: "1", jobId: fixture.evidence.jobId, phase: "pay-dem", outcome: "failure",
    reason: "payment declined", observedAt: 100, signature: fixture.evidence.signature };
  assert.equal(isSettlementEvidence(failure), true, "the failure evidence is SDK-valid");
  const failed = context("demos-native:DEM", "pay-dem", [{ index: 2, kind: "pay-dem", outcome: "fail" }]);
  assert.deepEqual(settlementClaims([{ raw: failure, logicalAddress: address(2) }], failed), { settlementTxIds: [], projected: true });
  // Beside a bound success claim it adds no id and does not disturb the claim.
  const second = { ...failure, phase: "pay-dem" };
  const both = context("demos-native:DEM", "pay-dem", [{ index: 1, kind: "pay-dem", outcome: "fail" }, { index: 2, kind: "pay-dem", outcome: "ok" }],
    [{}, { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }, { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }]);
  assert.deepEqual(settlementClaims([{ raw: second, logicalAddress: address(1) }, { raw: fixture.evidence, logicalAddress: address(2) }], both), {
    settlementTxIds: [{ id: `demos:${(fixture.evidence.paymentTxRefs as Array<{ txHash: string }>)[0].txHash}`, observedAt: 100, phaseIndex: 2 }],
    projected: true });
});

test("SB-1 requires a claim for an ok settle-labelled phase whatever the signed pipeline names", async () => {
  const { context } = await projectionFixture(8400);
  const settle = [{ index: 2, kind: "settle", outcome: "ok" }];
  for (const [name, pipeline] of [
    ["a pipeline entry of another kind", [{}, {}, { kind: "custom" }]],
    ["an empty pipeline entry", [{}, {}, {}]],
    ["no pipeline entry at the index", []],
    ["no pipeline", undefined],
  ] as const) {
    assert.deepEqual(settlementClaims([], context("demos-native:DEM", "pay-dem", settle, pipeline)),
      { settlementTxIds: [], projected: false }, name);
  }
  // A settle label whose phase did not succeed needs none.
  assert.equal(settlementClaims([], context("demos-native:DEM", "pay-dem", [{ index: 2, kind: "settle", outcome: "fail" }], [])).projected, true);
});

test("SB-1 binds each claim to the phase its own PC-2 index names", async () => {
  const { fixture, context, address } = await projectionFixture(8500);
  const phase = (index: number, outcome: string) => ({ index, kind: "pay-dem", outcome });
  const pipeline = [{}, { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }, { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }];
  const at = (index: number) => ({ raw: fixture.evidence, logicalAddress: address(index) });
  const txId = (phaseIndex: number) => ({ id: `demos:${(fixture.evidence.paymentTxRefs as Array<{ txHash: string }>)[0].txHash}`, observedAt: 100, phaseIndex });
  for (const flip of [false, true]) {
    const order = <T,>(entries: T[]): T[] => flip ? [...entries].reverse() : entries;
    // Phase 1 succeeded and phase 2 failed: the second claim must be refused against its own phase.
    assert.deepEqual(settlementClaims([at(1), at(2)], context("demos-native:DEM", "pay-dem", order([phase(1, "ok"), phase(2, "fail")]), pipeline)),
      { settlementTxIds: [txId(1)], projected: false }, `ok then fail, reversed ${flip}`);
    // Phase 1 failed and phase 2 succeeded: only the second claim is accepted, and nothing is left unclaimed.
    assert.deepEqual(settlementClaims([at(2)], context("demos-native:DEM", "pay-dem", order([phase(1, "fail"), phase(2, "ok")]), pipeline)),
      { settlementTxIds: [txId(2)], projected: true }, `fail then ok, reversed ${flip}`);
    // A claim for an index no summary entry names is refused, whatever the first entry says.
    assert.equal(settlementClaims([at(3)], context("demos-native:DEM", "pay-dem", order([phase(1, "ok"), phase(2, "ok")]), pipeline)).projected, false);
    // Both phases succeeded and both are claimed.
    assert.deepEqual(settlementClaims([at(1), at(2)], context("demos-native:DEM", "pay-dem", order([phase(1, "ok"), phase(2, "ok")]), pipeline)),
      { settlementTxIds: [txId(1), txId(2)], projected: true }, `ok and ok, reversed ${flip}`);
  }
  // A non-record summary entry ahead of the named phase does not stand in for it.
  assert.equal(settlementClaims([at(2)], context("demos-native:DEM", "pay-dem", [null, phase(2, "ok")], pipeline)).projected, true);
  assert.equal(settlementClaims([at(2)], context("demos-native:DEM", "pay-dem", [null, "x", phase(1, "ok")], pipeline)).projected, false);
});

test("SB-1 projects a correctly bound payment at multi-digit PC-2 phase index 12", async () => {
  const { fixture, context, address } = await projectionFixture(8900);
  assert.equal(isSettlementEvidence(fixture.evidence), true);
  const pipeline = Array.from({ length: 13 }, (_, index) => index === 12
    ? { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } } : {});
  const phaseSummary = [{ index: 12, kind: "pay-dem", outcome: "ok" }];
  assert.deepEqual(settlementClaims([{ raw: fixture.evidence, logicalAddress: address(12) }],
    context("demos-native:DEM", "pay-dem", phaseSummary, pipeline)), {
    settlementTxIds: [{ id: `demos:${(fixture.evidence.paymentTxRefs as Array<{ txHash: string }>)[0].txHash}`,
      observedAt: 100, phaseIndex: 12 }],
    projected: true,
  });
});

/** One evidence-only anchor adapter over the shared fixture maps. */
async function evidenceGraphAt(offset: number, deps: {
  read?: (at: string) => Obj | null | undefined; anchor?: (at: string) => unknown;
}) {
  const fixture = await vector("01KTY8ZJ12CW7KSECW3FS6PQPK", offset);
  const reads: string[] = [];
  const anchors: string[] = [];
  const graph = await buildCurrentEvidenceGraph(fixture.locators.buyer, {
    read: async (at) => { reads.push(at); return deps.read?.(at) === undefined ? maps.get(at) ?? null : deps.read(at) ?? null; },
    readEvidenceAnchor: async (at) => { anchors.push(at); return deps.anchor!(at) as never; },
    resolveListing: async () => ({ locator: fixture.locators.listing, raw: fixture.listing }),
  });
  return { fixture, graph, reads, anchors };
}

test("an evidence anchor read supplies the signed bytes and the logical address together, with no fallback", async () => {
  const offset = 8600;
  const evidenceAt = locator(offset + 3);
  const address = paymentEvidenceAddress("01KTY8ZJ12CW7KSECW3FS6PQPK", "demos-native:DEM", 2);
  const anchorOnly = (at: string) => { if (at !== evidenceAt) throw new Error("evidence-only adapter"); return { data: maps.get(at), logicalAddress: address }; };
  // The generic read neither supplies nor contradicts the anchored bytes.
  for (const [name, read] of [
    ["no generic bytes", (at: string) => at === evidenceAt ? null : undefined],
    ["other generic bytes", (at: string) => at === evidenceAt ? { ...maps.get(at), observedAt: 101 } : undefined],
  ] as const) {
    const { graph, reads, anchors } = await evidenceGraphAt(offset, { read, anchor: anchorOnly });
    assert.equal(graph.ok, true, `${name}: ${graph.reason}`);
    assert.deepEqual(anchors, [evidenceAt], `${name}: only evidence anchors are read natively`);
    assert.ok(!reads.includes(evidenceAt), `${name}: no second evidence read`);
    assert.equal(graph.artifacts.find((artifact) => artifact.kind === "evidence")?.logicalAddress, address, name);
    assert.ok(graph.artifacts.filter((artifact) => artifact.kind !== "evidence").every((artifact) => artifact.logicalAddress === undefined), name);
  }
  // Metadata the same read did not carry stays absent rather than coming from elsewhere.
  const bare = await evidenceGraphAt(offset, { anchor: (at) => ({ data: maps.get(at) }) });
  assert.equal(bare.graph.ok, true, bare.graph.reason);
  assert.equal(bare.graph.artifacts.find((artifact) => artifact.kind === "evidence")?.logicalAddress, undefined);
  // An authoritative null is a failure, even though the generic read would have found valid bytes.
  const missing = await evidenceGraphAt(offset, { anchor: () => null });
  assert.equal(missing.graph.ok, false);
  assert.ok(!missing.reads.includes(evidenceAt), "a null anchor read never falls back to the generic read");
  // Anchored bytes that do not hash to the signed reference fail, whatever the generic read holds.
  const tampered = await evidenceGraphAt(offset, { anchor: (at) => ({ data: { ...maps.get(at), observedAt: 101 }, logicalAddress: address }) });
  assert.equal(tampered.graph.ok, false);
});

test("an evidence graph shape pins the evidence version, phase type, outcomes and observation time", async () => {
  const { fixture, graph: baseline } = await evidenceGraphAt(8700, { anchor: (at) => ({ data: maps.get(at) }) });
  assert.equal(baseline.ok, true, baseline.reason);
  const evidenceAt = fixture.locators.evidence;
  const variants: Array<[string, Obj, boolean]> = [
    ["success outcome", {}, true],
    ["failure outcome", { outcome: "failure", reason: "declined", paymentTxRefs: undefined, paymentAmount: undefined, settlementFinality: undefined }, true],
    ["unknown outcome", { outcome: "partial" }, false],
    ["another evidence version", { evidenceVersion: "2" }, false],
    ["numeric phase", { phase: 7 }, false],
    ["string observation time", { observedAt: "100" }, false],
    ["missing observation time", { observedAt: undefined }, false],
  ];
  for (const [name, change, accepted] of variants) {
    const scope = { ...signedScope(fixture.evidence, "evidence"), ...change };
    for (const key of Object.keys(scope)) if (scope[key] === undefined) delete scope[key];
    const resigned = { ...scope, signature: await sign(scope, "evidence", 1) };
    // The bundle must reference the changed evidence for the graph to read it.
    const bundleScope = signedScope(fixture.buyerBundle, "bundle");
    bundleScope.settlementEvidence = [ref(evidenceAt, resigned, "evidence")];
    const bundle = { ...bundleScope, signatures: [await sign(bundleScope, "bundle", 0, true), await sign(bundleScope, "bundle", 1, true)], anchoredByRole: "buyer" };
    maps.set(evidenceAt, resigned);
    maps.set(fixture.locators.buyer, bundle);
    const graph = await buildCurrentEvidenceGraph(fixture.locators.buyer, {
      read: async (at) => maps.get(at) ?? null, readEvidenceAnchor: async (at) => ({ data: maps.get(at)! }),
      resolveListing: async () => ({ locator: fixture.locators.listing, raw: fixture.listing }),
    });
    assert.equal(graph.ok, accepted, `${name}: ${graph.reason}`);
  }
});

// ---- Cached listing hints and seller windows (testnetMetrics) ----

const hintDeals = [
  deal("a", { anchorTimestamp: 50, settlementTxIds: [] }), deal("b", { anchorTimestamp: 100, settlementTxIds: [] }),
  deal("c", { anchorTimestamp: 150, settlementTxIds: [] }),
];
const cachedHint = (values: Record<string, unknown>) => ({
  categoryScope: "services", bundleCount: 99, windowStart: 0, windowEnd: 200, computedAt: 200, completionRate: 1, ...values,
}) as unknown as ReputationHint;
const withHint = (hint: unknown, category = "services.test", deals = hintDeals) =>
  seller(deals, {}, { offering: { category }, reputationHint: hint } as unknown as Partial<ListingSummary>);
const coordinates = (hint: ReputationHint) => [hint.categoryScope, hint.windowStart, hint.windowEnd, hint.computedAt, hint.bundleCount];

test("a cached hint whose scope is not a string falls back instead of aborting the read", () => {
  for (const scope of [["services"], { length: 3 }, [], 7, null]) {
    const record = withHint(cachedHint({ categoryScope: scope }));
    assert.doesNotThrow(() => rebuildCatalogObservations(catalogOf([record])), JSON.stringify(scope));
    assert.deepEqual(coordinates(hintOf(record)), ["services.test", 0, 200, 200, 3], JSON.stringify(scope));
    assert.deepEqual(coordinates(projectTestnetCatalog(catalogOf([record])).sellers[0].listings[0].reputationHint!), ["services.test", 0, 200, 200, 3]);
  }
});

test("an empty cached scope is replaced even when a dot-leading category would relate to it", () => {
  const record = withHint(cachedHint({ categoryScope: "" }), ".test", hintDeals.map((entry) => ({ ...entry, category: ".test" })));
  assert.deepEqual(coordinates(hintOf(record)), [".test", 0, 200, 200, 3]);
  // The same cached scope is served when it is a real parent of the category.
  assert.deepEqual(coordinates(hintOf(withHint(cachedHint({ categoryScope: "services", windowStart: 60, windowEnd: 120, computedAt: 130 })))),
    ["services", 60, 120, 130, 1]);
  // A scope that is not the category or one of its parents is replaced.
  assert.deepEqual(coordinates(hintOf(withHint(cachedHint({ categoryScope: "services.te" })))), ["services.test", 0, 200, 200, 3]);
  assert.deepEqual(coordinates(hintOf(withHint(cachedHint({ categoryScope: "other" })))), ["services.test", 0, 200, 200, 3]);
});

test("a valid cached hint is kept: zero coordinates, the exact category and a zero-width window", () => {
  // computedAt 0 and windowStart 0 are valid coordinates, not missing ones.
  assert.deepEqual(coordinates(hintOf(withHint(cachedHint({ windowStart: 10, windowEnd: 120, computedAt: 0 })))), ["services", 10, 120, 0, 2]);
  assert.deepEqual(coordinates(hintOf(withHint(cachedHint({ windowStart: 0, windowEnd: 120, computedAt: 150 })))), ["services", 0, 120, 150, 2]);
  assert.deepEqual(coordinates(hintOf(withHint(cachedHint({ windowStart: 0, windowEnd: 0, computedAt: 0 })))), ["services", 0, 0, 0, 0]);
  // A cached hint for exactly the listing's category is kept with its own window and clock.
  assert.deepEqual(coordinates(hintOf(withHint(cachedHint({ categoryScope: "services.test", windowStart: 10, windowEnd: 140, computedAt: 160 })))),
    ["services.test", 10, 140, 160, 2]);
  // A zero-width window keeps only observations at that instant.
  assert.deepEqual(coordinates(hintOf(withHint(cachedHint({ windowStart: 100, windowEnd: 100, computedAt: 150 })))), ["services", 100, 100, 150, 1]);
  // A reversed window is replaced by the snapshot's.
  assert.deepEqual(coordinates(hintOf(withHint(cachedHint({ windowStart: 120, windowEnd: 100, computedAt: 150 })))), ["services.test", 0, 200, 200, 3]);
  // The public projection serves the same hint and never a rate.
  const served = projectTestnetCatalog(catalogOf([withHint(cachedHint({ windowStart: 100, windowEnd: 100, computedAt: 150 }))])).sellers[0].listings[0].reputationHint!;
  assert.deepEqual(coordinates(served), ["services", 100, 100, 150, 1]);
  assert.equal(served.completionRate, null);
});

test("seller reputation windows keep a valid narrow or zero-width span and repair a reversed or missing one", () => {
  const windows: Array<[string, unknown, [number, number], number]> = [
    ["reversed", { windowStart: 100, windowEnd: 50 }, [100, 200], 2],
    ["zero-width", { windowStart: 100, windowEnd: 100 }, [100, 100], 1],
    ["narrower than the snapshot", { windowStart: 0, windowEnd: 100 }, [0, 100], 2],
    ["unsafe end", { windowStart: 100, windowEnd: -1 }, [100, 200], 2],
    ["unsafe start", { windowStart: -5, windowEnd: 120 }, [0, 120], 2],
    ["missing", undefined, [0, 200], 3],
  ];
  for (const [name, reputation, [start, end], count] of windows) {
    const record = seller(hintDeals, reputation ? { reputation } as unknown as Partial<SellerRecord> : {});
    for (const result of [rebuildCatalogObservations(catalogOf([record])), projectTestnetCatalog(catalogOf([record]))]) {
      assert.deepEqual([result.sellers[0].reputation.windowStart, result.sellers[0].reputation.windowEnd], [start, end], name);
      assert.equal(result.sellers[0].reputation.bundleCount, count, name);
    }
  }
});

test("the public projection keeps a missing deals member empty and the eligibility of current records", () => {
  const record = seller(hintDeals);
  delete (record as { deals?: DealRecord[] }).deals;
  // The writer's rebuild retains the source record as cached; only the public projection spells the member.
  assert.deepEqual(projectTestnetCatalog(catalogOf([record])).sellers[0].deals, []);
  for (const result of [rebuildCatalogObservations(catalogOf([record])), projectTestnetCatalog(catalogOf([record]))]) {
    assert.equal(result.sellers[0].reputation.bundleCount, 0);
    assert.equal(result.sellers[0].listings[0].reputationHint!.bundleCount, 0);
  }
  const mixed = seller([deal("a", { settlementTxIds: [] }),
    deal("b", { settlementTxIds: [], settlementProjectionVersion: SETTLEMENT_PROJECTION_VERSION - 1 }),
    deal("c", { settlementTxIds: [], reputationEligible: false })]);
  const projected = projectTestnetCatalog(catalogOf([mixed])).sellers[0];
  assert.deepEqual(projected.deals.map((entry) => entry.reputationEligible), [true, false, false]);
  assert.equal(projected.reputation.bundleCount, 1);
  // The writer's rebuild retains each record's source eligibility; only counting applies the version gate.
  const rebuilt = rebuildCatalogObservations(catalogOf([mixed])).sellers[0];
  assert.deepEqual(rebuilt.deals.map((entry) => entry.reputationEligible), [true, true, false]);
  assert.equal(rebuilt.reputation.bundleCount, 1);
});

test("missing or null cached listings stay empty while real deals and counts are retained", () => {
  for (const state of ["missing", "null"] as const) {
    const record = seller(hintDeals);
    if (state === "missing") delete (record as { listings?: ListingSummary[] }).listings;
    else (record as unknown as { listings: null }).listings = null;
    for (const project of [rebuildCatalogObservations, projectTestnetCatalog]) {
      const projected = project(catalogOf([record])).sellers[0];
      assert.deepEqual(projected.listings, [], `${state}: ${project.name}`);
      assert.deepEqual(projected.deals, hintDeals, `${state}: ${project.name}`);
      assert.equal(projected.reputation.bundleCount, 3, `${state}: ${project.name}`);
      assert.deepEqual(projected.reputation.bundleRefs?.map((entry) => entry.id), ["a", "b", "c"]);
    }
  }
});

// ---- End to end: additive fields on non-evidence artifacts ----

async function indexFixture(fixture: Awaited<ReturnType<typeof vector>>, extra: Record<string, unknown> = {}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const data = maps.get(String(input).split("/").pop() ?? "");
    return new Response(JSON.stringify(data ? { success: true, owner: `0x${dids[1].slice(-64)}`, programName: "dacs:test",
      metadata: { logicalAddress: evidenceAddresses.get(String(input).split("/").pop() ?? "") }, data } : { success: false }),
      { status: data ? 200 : 404, headers: { "content-type": "application/json" } });
  };
  try {
    return await indexRegistration({ primaryClaim: dids[1], displayName: "seller", listingAnchors: [fixture.locators.listing], ...extra } as never,
      undefined, async () => { throw new Error("identity unavailable"); });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("SB-1 a valid and an unprojectable current Demos TxRef make the indexed deal non-countable", async () => {
  const jobId = "01KTY8ZJ14CW7KSECW3FS6PQPK";
  for (const mixed of [false, true]) {
    const paymentTxRefs = mixed ? [arms.demos, { kind: "demos", txHash: "short" }] : [arms.demos];
    const fixture = await vector(jobId, 9000, paymentTxRefs);
    assert.equal(isSettlementEvidence(fixture.evidence), true, "both current refs are SDK-valid");
    const expectedIds = [{ id: `demos:${hash}`, observedAt: 100, phaseIndex: 2 }];
    assert.deepEqual(settlementClaims([{
      raw: fixture.evidence, logicalAddress: evidenceAddresses.get(fixture.locators.evidence),
    }], {
      jobId, railId: "demos-native:DEM", railRegistryVersion: 1,
      phaseSummary: fixture.buyerBundle.phaseSummary, pipeline: fixture.listing.pipeline,
    }), { settlementTxIds: expectedIds, projected: !mixed });
    const record = await indexFixture(fixture, {
      deals: [registeredDeal(jobId, fixture.locators.buyer, fixture.locators.seller)],
      bundleBindings: [
        await bindingFor(jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
        await bindingFor(jobId, "seller", fixture.locators.seller, fixture.sellerBundle, 1),
      ],
    });
    assert.equal(record.deals.length, 1);
    assert.equal(record.deals[0].signatureVerified, true);
    assert.equal(record.deals[0].refsVerified, true, "graph verification succeeds for both variants");
    assert.deepEqual(record.deals[0].settlementTxIds, expectedIds);
    assert.equal(record.deals[0].reputationEligible, !mixed);
    assert.equal(countableDeals(record.deals, 0, Date.now()).deals.length, mixed ? 0 : 1);
    assert.equal(record.reputation.bundleCount, mixed ? 0 : 1);
    assert.equal(record.listings[0].reputationHint!.bundleCount, mixed ? 0 : 1);
  }
});

test("an additive outcome field on a rating does not turn it into settlement evidence", async () => {
  const jobId = "01KTY8ZJ13CW7KSECW3FS6PQPK";
  const fixture = await vector(jobId, 8800);
  const ratingAt = fixture.locators.rating;
  const ratingScope = { ...signedScope(fixture.rating, "rating"), outcome: "success" };
  const rating = { ...ratingScope, signature: await sign(ratingScope, "rating", 0) };
  maps.set(ratingAt, rating);
  for (const [role, where] of [["buyer", fixture.locators.buyer], ["seller", fixture.locators.seller]] as const) {
    const scope = signedScope(maps.get(where)!, "bundle");
    scope.ratingRefs = [ref(ratingAt, rating, "rating")];
    const bundle = { ...scope, signatures: [await sign(scope, "bundle", 0, true), await sign(scope, "bundle", 1, true)], anchoredByRole: role };
    maps.set(where, bundle);
    if (role === "buyer") fixture.buyerBundle = bundle; else fixture.sellerBundle = bundle;
  }
  const record = await indexFixture(fixture, { deals: [registeredDeal(jobId, fixture.locators.buyer, fixture.locators.seller)], bundleBindings: [
    await bindingFor(jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
    await bindingFor(jobId, "seller", fixture.locators.seller, fixture.sellerBundle, 1),
  ] });
  assert.equal(record.deals[0].refsVerified, true);
  assert.equal(record.deals[0].ratings?.length, 1, "the rating is retained as evidence");
  assert.equal(record.deals[0].reputationEligible, true);
  assert.deepEqual(record.deals[0].settlementTxIds?.map((tx) => tx.phaseIndex), [2]);
  assert.equal(record.reputation.bundleCount, 1);
  assert.equal(record.listings[0].reputationHint!.bundleCount, 1);
});
