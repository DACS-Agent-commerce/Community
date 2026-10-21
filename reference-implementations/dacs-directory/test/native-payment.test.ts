import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { demOs, nativePaymentVerdict, verifyNativePayment } from "../src/catalog/nativePayment.js";
import { VerificationUnavailable } from "../src/catalog/verificationUnavailable.js";

// Read-only node2 (https://node2.demos.sh) replies, retained byte-for-byte: transaction/block and the
// -556299 pair were captured on 2026-10-17 and are gone since node2's chain reset; the -873 pair and
// not-found were captured on 2026-10-20 (checkedThroughBlock 2594). No node revision is attested.
const raw = (name: string) => readFileSync(new URL(`./fixtures/native-payment/${name}.json`, import.meta.url), "utf8");
const captured = (name: string) => JSON.parse(raw(name)).response;
const tx = captured("transaction");
const block = captured("block");
const ref = { txHash: tx.hash, blockNumber: tx.blockNumber };
const agreement = {
  parties: [
    { role: "buyer", primaryClaim: `did:demos:agent:${tx.content.from.slice(2)}` },
    { role: "seller", primaryClaim: `did:demos:agent:${tx.content.to.slice(2)}` },
  ],
  terms: { price: { amount: "1", currency: "DEM" } },
};
const check = (changed = tx, changedBlock = block) => verifyNativePayment(ref, agreement, 2,
  async (message) => message === "getTxByHash" ? changed : changedBlock);

test("captured confirmed native payment decodes numeric stored OS and string payload OS", async () => {
  assert.equal(tx.content.amount, 1_000_000_000);
  assert.equal(tx.content.data[1].args[1], "1000000000");
  assert.equal(await check(), "pass");
});

test("the same captured native payment also accepts an exact stored OS string", async () => {
  assert.equal(await check({ ...tx, content: { ...tx.content, amount: "1000000000" } }), "pass");
});

test("legacy numeric DEM send payloads remain indeterminate instead of guessing a unit", async () => {
  for (const legacyDem of [1, 0.5, 1_000_000_000]) {
    const changed = structuredClone(tx);
    changed.content.amount = legacyDem;
    changed.content.data[1].args[1] = legacyDem;
    assert.equal(await check(changed), "indeterminate");
  }
});

test("numeric OS is exact and must agree with the payload and signed price", async () => {
  for (const amount of [1, 999_999_999, Number.MAX_SAFE_INTEGER + 1, -1, 1.5, null, "01", "1e9"]) {
    assert.equal(await check({ ...tx, content: { ...tx.content, amount } }), "fail", String(amount));
  }
  const changed = structuredClone(tx);
  changed.content.data[1].args[1] = "999999999";
  assert.equal(await check(changed), "fail");
});

test("captured transfer still needs terminal block inclusion and the agreed endpoints", async () => {
  assert.equal(await check(null), "indeterminate");
  assert.equal(await check({ ...tx, status: "pending" }), "indeterminate");
  assert.equal(await check({ ...tx, content: { ...tx.content, to: tx.content.from } }), "fail");
  assert.equal(await check(tx, { ...block, content: { ordered_transactions: [] } }), "fail");
});

// A second independently captured transfer exercises the same RPC field contract.
test("a second captured confirmed transfer verifies numeric and string OS", async () => {
  const observed = captured("transaction-556299");
  const included = captured("block-556299");
  const agreed = { parties: [
    { role: "buyer", primaryClaim: `did:demos:agent:${observed.content.from.slice(2)}` },
    { role: "seller", primaryClaim: `did:demos:agent:${observed.content.to.slice(2)}` },
  ], terms: { price: { amount: "1", currency: "DEM" } } };
  assert.equal(observed.content.amount, 1_000_000_000);
  for (const amount of [observed.content.amount, String(observed.content.amount)]) {
    const changed = { ...observed, content: { ...observed.content, amount } };
    assert.equal(await verifyNativePayment({ txHash: observed.hash, blockNumber: observed.blockNumber }, agreed, 2,
      async (message) => message === "getTxByHash" ? changed : included), "pass");
  }
});

test("PB-2 binds a payee-bound native destination to the seller primary claim", async () => {
  const payeeBound = { ...agreement, payeeBoundAgreementVersion: "1", terms: { ...agreement.terms,
    rail: { railId: "demos-native:DEM" }, payoutBindings: [{ railId: "demos-native:DEM", phaseIndex: 2, payeeAddress: tx.content.to }] } };
  const read = async (message: string) => message === "getTxByHash" ? tx : block;
  assert.equal(await verifyNativePayment(ref, payeeBound, 2, read), "pass");
  const unrelatedSeller = { ...payeeBound, parties: [agreement.parties[0], { role: "seller", primaryClaim: `did:demos:agent:${"e".repeat(64)}` }] };
  assert.equal(await verifyNativePayment(ref, unrelatedSeller, 2, read), "fail", "real transfer and co-signed payout do not substitute seller identity");
});

test("PB-2 reads the payee from this phase's own payout binding, not from the seller claim", async () => {
  const read = async (message: string) => message === "getTxByHash" ? tx : block;
  const other = `0x${"e".repeat(64)}`;
  const bound = (payoutBindings: Array<Record<string, unknown>>) => ({ ...agreement, payeeBoundAgreementVersion: "1",
    terms: { ...agreement.terms, rail: { railId: "demos-native:DEM" }, payoutBindings } });
  // The transfer goes to the seller, but this phase's binding names someone else.
  assert.equal(await verifyNativePayment(ref, bound([{ railId: "demos-native:DEM", phaseIndex: 2, payeeAddress: other }]), 2, read), "fail");
  // Only another pay phase's binding, or another rail's binding at this index, names the seller.
  const twoPhases = bound([{ railId: "demos-native:DEM", phaseIndex: 2, payeeAddress: other }, { railId: "demos-native:DEM", phaseIndex: 4, payeeAddress: tx.content.to }]);
  assert.equal(await verifyNativePayment(ref, twoPhases, 2, read), "fail");
  assert.equal(await verifyNativePayment(ref, twoPhases, 4, read), "pass");
  assert.equal(await verifyNativePayment(ref, bound([{ railId: "demos-native:DEM", phaseIndex: 4, payeeAddress: tx.content.to }]), 2, read), "fail");
  assert.equal(await verifyNativePayment(ref, bound([{ railId: "other-rail", phaseIndex: 2, payeeAddress: tx.content.to }]), 2, read), "fail");
});

// The pinned node credits and debits the exact address string (ac8f45f handleNativeOperations →
// GCRBalanceRoutines findOneBy({ pubkey })), and its TO check accepts hex in either case, so a
// send to another spelling of the payee's key credits a different account.
test("the node's sender and recipient strings must be the canonical payer and payee exactly", async () => {
  const upper = (address: string) => `0x${address.slice(2).toUpperCase()}`;
  assert.notEqual(upper(tx.content.to), tx.content.to);
  assert.notEqual(upper(tx.content.from), tx.content.from);
  const spelled = (change: (content: any) => void) => { const changed = structuredClone(tx); change(changed.content); return check(changed); };
  assert.equal(await spelled(() => {}), "pass");
  assert.equal(await spelled((content) => { content.to = upper(content.to); content.data[1].args[0] = upper(content.data[1].args[0]); }), "fail", "recipient");
  assert.equal(await spelled((content) => { content.data[1].args[0] = upper(content.data[1].args[0]); }), "fail", "credited account");
  assert.equal(await spelled((content) => { content.to = upper(content.to); }), "fail", "transaction recipient");
  assert.equal(await spelled((content) => { content.from = upper(content.from); }), "fail", "sender");
  assert.equal(await spelled((content) => { content.data[1].args[0] = content.data[1].args[0].slice(2); }), "fail", "unprefixed recipient");
});

test("§9.5.9 inclusion needs this transaction's hash in the block, not just the block number", async () => {
  const others = ["cd".repeat(32), `0x${"ef".repeat(32)}`];
  assert.equal(await check(tx, { ...block, content: { ...block.content, ordered_transactions: others } }), "fail");
  assert.equal(await check(tx, { ...block, content: { ...block.content, ordered_transactions: [...others, tx.hash] } }), "pass");
  // The transaction itself names another block than the evidence cites: the evidence is refuted.
  assert.equal(await check({ ...tx, blockNumber: tx.blockNumber + 1 }), "fail");
});

// DACS-5 §10.5.1: only the node's answer about this transaction refutes it. A reply about another
// transaction or block, or one that lists nothing, is no answer, and the payment stays undecided.
test("a node reply about another transaction or block leaves the payment undecided", async () => {
  assert.equal(await check({ ...tx, hash: "cd".repeat(32) }), "indeterminate");
  assert.equal(await check({ ...tx, hash: undefined }), "indeterminate");
  assert.equal(await check(tx, { ...block, number: tx.blockNumber + 1 }), "indeterminate");
  assert.equal(await check(tx, { ...block, content: {} }), "indeterminate");
  assert.equal(await check(tx, { notFound: true, checkedThroughBlock: tx.blockNumber + 10 }), "indeterminate");
  assert.equal(await check(tx, null), "indeterminate");
});

test("a structured not-found refutes the payment only when the node checked through the cited block", async () => {
  const missing = (checkedThroughBlock: number) => nativePaymentVerdict(ref, agreement, 2,
    async (message) => message === "getTxByHash" ? { notFound: true, checkedThroughBlock } : block);
  assert.deepEqual(await missing(tx.blockNumber), { verdict: "fail", reason: `the node has no such transaction through block ${tx.blockNumber}` });
  assert.deepEqual(await missing(tx.blockNumber + 1), { verdict: "fail", reason: `the node has no such transaction through block ${tx.blockNumber + 1}` });
  assert.deepEqual(await missing(tx.blockNumber - 1), { verdict: "indeterminate", reason: `the node has checked only through block ${tx.blockNumber - 1}`, kind: "no-answer" });
  // Not a not-found answer without a safe block number.
  for (const answer of [{ notFound: true }, { notFound: true, checkedThroughBlock: "9" }, { notFound: true, checkedThroughBlock: 1.5 }]) {
    assert.equal(await check(answer as never), "indeterminate", JSON.stringify(answer));
  }
});

test("an undecided payment keeps the node's cause and its kind", async () => {
  const verdict = await nativePaymentVerdict(ref, agreement, 2, async () => { throw new VerificationUnavailable("the node's getTxByHash reply failed (timeout)", "no-answer"); });
  assert.deepEqual(verdict, { verdict: "indeterminate", reason: "the node's getTxByHash reply failed (timeout)", kind: "no-answer" });
  assert.deepEqual(await nativePaymentVerdict(ref, agreement, 2, async () => { throw new VerificationUnavailable("a record kept closed", "lasting"); }),
    { verdict: "indeterminate", reason: "a record kept closed", kind: "lasting" });
  assert.deepEqual(await nativePaymentVerdict(ref, agreement, 2), { verdict: "indeterminate", reason: "no node reader is installed", kind: "lasting" });
});

// Sweep 13 code F1: only no answer may hold a seller. A state of the transaction or block itself, which no later
// read changes, is lasting; a reply about something else, or one that cannot be read, is no answer.
test("each undecided payment says whether a later pass can decide it", async () => {
  const kind = async (changed: unknown, changedBlock: unknown = block) => {
    const verdict = await nativePaymentVerdict(ref, agreement, 2, async (message) => message === "getTxByHash" ? changed : changedBlock);
    return verdict.verdict === "indeterminate" ? verdict.kind : verdict.verdict;
  };
  const numeric = structuredClone(tx); numeric.content.data[1].args[1] = 1;
  assert.equal(await kind(numeric), "lasting", "a numeric legacy send payload");
  assert.equal(await kind(tx, { ...block, attrs: { gcrAppliedTxs: [] } }), "lasting", "a stated applied list without the transfer");
  assert.equal(await kind(tx, { ...block, attrs: { gcrAppliedTxs: ["cd".repeat(32)] } }), "lasting", "an applied list naming another transfer");
  for (const [name, changed, changedBlock] of [
    ["no transaction in the reply", null, block],
    ["another transaction", { ...tx, hash: "cd".repeat(32) }, block],
    ["a pending transaction", { ...tx, status: "pending" }, block],
    ["another block", tx, { ...block, number: tx.blockNumber + 1 }],
    ["a block listing no transactions", tx, { ...block, content: {} }],
    ["an applied list that is not a list", tx, { ...block, attrs: { gcrAppliedTxs: tx.hash } }],
    ["block attrs that are not an object", tx, { ...block, attrs: [tx.hash] }],
  ] as Array<[string, unknown, unknown]>) assert.equal(await kind(changed, changedBlock), "no-answer", name);
  // A reader error the production reader would never throw has no known cause, so it holds nothing.
  assert.deepEqual(await nativePaymentVerdict(ref, agreement, 2, async () => { throw new Error("node unreachable"); }),
    { verdict: "indeterminate", reason: "node unreachable", kind: "lasting" });
});

// Sweep 13 code F1(c): a completed bundle asserts a transfer that existed when it was anchored. A cited block beyond
// the node's checked height refutes the payment only when that height is already later than the bundle's
// consensus anchor, as the node's own block timestamp shows; otherwise the node is behind, which is no answer.
test("a cited block after the citing bundle's consensus anchor is refuted", async () => {
  const anchoredAt = block.content.timestamp * 1_000;
  const future = { txHash: "cd".repeat(32), blockNumber: Number.MAX_SAFE_INTEGER };
  const reads: unknown[] = [];
  const verdict = (checkedBlock: unknown, bundleAnchoredAt: number | null = anchoredAt) => nativePaymentVerdict(future, agreement, 2,
    async (message, data) => { reads.push([message, data]); return message === "getTxByHash" ? { notFound: true, checkedThroughBlock: block.number } : checkedBlock; },
    bundleAnchoredAt ?? undefined);
  const later = { ...block, content: { ...block.content, timestamp: block.content.timestamp + 1 } };
  assert.deepEqual(await verdict(later), { verdict: "fail",
    reason: `the cited block ${Number.MAX_SAFE_INTEGER} follows block ${block.number}, which is later than the bundle's consensus anchor` });
  assert.deepEqual(reads.at(-1), ["getBlockByNumber", { blockNumber: block.number }]);
  const behind = { verdict: "indeterminate", reason: `the node has checked only through block ${block.number}`, kind: "no-answer" };
  for (const [name, checkedBlock] of [
    ["a block at the anchor time", block],
    ["a block that is not confirmed", { ...later, status: "pending" }],
    ["a reply about another block", { ...later, number: block.number + 1 }],
    ["a block without a timestamp", { ...later, content: { ordered_transactions: [] } }],
    ["a block with a fractional timestamp", { ...later, content: { ...later.content, timestamp: block.content.timestamp + 0.5 } }],
    ["no block", null],
  ] as Array<[string, unknown]>) assert.deepEqual(await verdict(checkedBlock), behind, name);
  // Without the bundle's own anchor time nothing is compared, and the block is not read.
  reads.length = 0;
  assert.deepEqual(await verdict(later, null), behind);
  assert.deepEqual(reads, [["getTxByHash", { hash: future.txHash }]]);
});

test("only a native send operation settles the agreement", async () => {
  for (const nativeOperation of ["transfer", "Send", "", undefined]) {
    const changed = structuredClone(tx);
    changed.content.data[1].nativeOperation = nativeOperation;
    assert.equal(await check(changed), "fail", String(nativeOperation));
  }
});

// Cold review P1-1. DACS-4 PaymentPhaseInput lets the buyer pay from any key in its bundle claims, and a legacy agreement
// pays the runtime payee.payeeAddress (§9.5.1). Refuting such a transfer dropped the completion while the listing's
// failures before commitment still counted. In a copy the seller signed it is the session's lasting state; in one it did
// not sign it is refuted, as before. Every term the agreement fixes, and the node's own record, still refutes it first.
test("cold review P1-1: a payer key, or a legacy payee, this profile cannot tie to its party leaves the payment undecided", async () => {
  const other = `0x${"e".repeat(64)}`;
  const verdict = (changed: unknown, untiedKeys?: "undecided" | "refuted", agreed: Record<string, unknown> = agreement, changedBlock: unknown = block) =>
    nativePaymentVerdict(ref, agreed, 2, async (message) => message === "getTxByHash" ? changed : changedBlock, undefined, untiedKeys);
  const sent = (change: (content: any) => void) => { const changed = structuredClone(tx); change(changed.content); return changed; };
  const fromOther = sent((content) => { content.from = other; });
  const toOther = sent((content) => { content.to = other; content.data[1].args[0] = other; });
  const payer = { verdict: "indeterminate", kind: "lasting",
    reason: "the transfer's payer is not the buyer's primary claim, and this profile does not resolve the other keys of the buyer's bundle" };
  const payee = { verdict: "indeterminate", kind: "lasting",
    reason: "the legacy agreement binds no destination, and the transfer's payee is not the seller's primary claim" };
  assert.deepEqual(await verdict(fromOther, "undecided"), payer);
  assert.deepEqual(await verdict(toOther, "undecided"), payee);
  assert.deepEqual(await verdict(sent((content) => { content.from = `0x${"d".repeat(64)}`; content.to = other; content.data[1].args[0] = other; }), "undecided"), payer);
  // In a copy the seller did not sign, and by default, the same transfers are refuted.
  for (const changed of [fromOther, toOther]) {
    assert.deepEqual(await verdict(changed), { verdict: "fail", reason: "the transaction is not the agreed native send in the cited block" });
    assert.equal((await verdict(changed, "refuted")).verdict, "fail");
  }
  // A payee-bound agreement fixes the destination (PB-1): another payee is refuted, another paying key is not.
  const payeeBound = { ...agreement, payeeBoundAgreementVersion: "1", terms: { ...agreement.terms,
    rail: { railId: "demos-native:DEM" }, payoutBindings: [{ railId: "demos-native:DEM", phaseIndex: 2, payeeAddress: tx.content.to }] } };
  assert.equal((await verdict(toOther, "undecided", payeeBound)).verdict, "fail");
  assert.deepEqual(await verdict(fromOther, "undecided", payeeBound), payer);
  const buyer = tx.content.from, seller = tx.content.to;
  for (const [name, changed, changedBlock] of [
    ["another block", { ...fromOther, blockNumber: tx.blockNumber + 1 }, block],
    ["another amount", sent((content) => { content.from = other; content.amount = 1; content.data[1].args[1] = "1"; }), block],
    ["not a native transaction", sent((content) => { content.from = other; content.type = "storageProgram"; }), block],
    ["not a send", sent((content) => { content.from = other; content.data[1].nativeOperation = "transfer"; }), block],
    ["a send argument naming another account", sent((content) => { content.from = other; content.data[1].args[0] = other; }), block],
    ["another spelling of a key", sent((content) => { content.from = `0x${"E".repeat(64)}`; }), block],
    ["a transfer to its own sender", sent((content) => { content.from = other; content.to = other; content.data[1].args[0] = other; }), block],
    ["a transfer to the buyer's account", sent((content) => { content.from = other; content.to = buyer; content.data[1].args[0] = buyer; }), block],
    ["a transfer from the seller's account", sent((content) => { content.from = seller; content.to = other; content.data[1].args[0] = other; }), block],
    ["a block that does not include it", fromOther, { ...block, content: { ...block.content, ordered_transactions: [] } }],
  ] as Array<[string, unknown, unknown]>) assert.equal((await verdict(changed, "undecided", agreement, changedBlock)).verdict, "fail", name);
});

// Cold review P2-N1: the numeric-payload check ran first, so it left any such transfer undecided, whatever it moved
// between whom and in which block. Only the amount is open in a numeric payload; every other check still refutes it.
test("a numeric legacy send payload leaves only its amount undecided", async () => {
  const numeric = (change: (changed: any) => void = () => {}) => {
    const changed = structuredClone(tx); changed.content.data[1].args[1] = 7; change(changed); return changed;
  };
  assert.deepEqual(await nativePaymentVerdict(ref, agreement, 2, async (message) => message === "getTxByHash" ? numeric() : block),
    { verdict: "indeterminate", reason: "a numeric legacy DEM send payload needs historical fork semantics", kind: "lasting" });
  const stranger = `0x${"e".repeat(64)}`;
  for (const [name, changed, changedBlock] of [
    ["another block", numeric((changed) => { changed.blockNumber += 1; }), block],
    ["not a native transaction", numeric((changed) => { changed.content.type = "storageProgram"; }), block],
    ["a transfer between strangers", numeric((changed) => {
      changed.content.from = `0x${"d".repeat(64)}`; changed.content.to = stranger; changed.content.data[1].args[0] = stranger;
    }), block],
    ["a send crediting another account", numeric((changed) => { changed.content.data[1].args[0] = stranger; }), block],
    ["a block that does not include it", numeric(), { ...block, content: { ...block.content, ordered_transactions: [] } }],
  ] as Array<[string, unknown, unknown]>) {
    assert.equal(await verifyNativePayment(ref, agreement, 2, async (message) => message === "getTxByHash" ? changed : changedBlock), "fail", name);
  }
});

test("multi-digit and fractional DEM prices convert exactly to OS", async () => {
  assert.deepEqual(["12", "10.5", "100.000000001"].map(demOs), [12_000_000_000n, 10_500_000_000n, 100_000_000_001n]);
  for (const [amount, os] of [["12", 12_000_000_000], ["10.5", 10_500_000_000]] as const) {
    const changed = structuredClone(tx);
    changed.content.amount = os;
    changed.content.data[1].args[1] = String(os);
    const priced = { ...agreement, terms: { price: { amount, currency: "DEM" } } };
    assert.equal(await verifyNativePayment(ref, priced, 2, async (message) => message === "getTxByHash" ? changed : block), "pass", amount);
  }
});

test("a node read that throws leaves the payment indeterminate", async () => {
  assert.equal(await verifyNativePayment(ref, agreement, 2, async () => { throw new Error("node unreachable"); }), "indeterminate");
});

// Review sweep 10 (code P2-1): node2 runs code newer than the pinned source. Its blocks list the
// transactions whose GCR edits they applied; where a block states that list, a transfer it does not
// name, or a list that cannot be read, establishes no settlement.
test("where the block lists its applied transactions, the transfer must be one of them", async () => {
  const applied = (attrs: unknown) => check(tx, { ...block, attrs });
  assert.deepEqual(block.attrs.gcrAppliedTxs, [tx.hash]);
  assert.equal(await applied(block.attrs), "pass");
  assert.equal(await applied({ ...block.attrs, gcrAppliedTxs: [`0x${tx.hash.toUpperCase()}`] }), "pass");
  for (const gcrAppliedTxs of [[], ["cd".repeat(32)], tx.hash, null]) {
    assert.equal(await applied({ ...block.attrs, gcrAppliedTxs }), "indeterminate", JSON.stringify(gcrAppliedTxs));
  }
  for (const attrs of [null, "attrs", [tx.hash]]) assert.equal(await applied(attrs), "indeterminate", JSON.stringify(attrs));
  // The pinned source's blocks carry no such list: inclusion in ordered_transactions decides.
  assert.equal(await applied(undefined), "pass");
  assert.equal(await applied({ gcrAppliedTxCount: 1 }), "pass");
});

test("node2 replies through the production reader: a confirmed transfer passes, a missing one is decided by how far the node checked", async () => {
  const { readSettlementNode } = await import("../src/catalog/chain.js");
  const sent = captured("transaction-873");
  const missing = "39783f8d22e49f7a7c2975b045f832b07c328c69a9a6c92d752ae415beb3f143";
  const requests: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const call = JSON.parse(String(init?.body)).params[0];
    requests.push(call);
    const name = call.message === "getBlockByNumber" ? "block-873" : call.data.hash === sent.hash ? "transaction-873" : "not-found";
    return new Response(raw(name), { headers: { "content-type": "application/json" } });
  };
  try {
    const agreed = { parties: [
      { role: "buyer", primaryClaim: `did:demos:agent:${sent.content.from.slice(2)}` },
      { role: "seller", primaryClaim: `did:demos:agent:${sent.content.to.slice(2)}` },
    ], terms: { price: { amount: "2400", currency: "DEM" } } };
    assert.equal(await verifyNativePayment({ txHash: sent.hash, blockNumber: sent.blockNumber }, agreed, 2, readSettlementNode), "pass");
    assert.deepEqual(requests[0], { type: "nodeCall", message: "getTxByHash", data: { hash: sent.hash }, sender: "", signature: "", extra: "" });
    assert.deepEqual(JSON.parse(raw("not-found")).extra, { reason: "not_found", checkedThroughBlock: 2594 });
    assert.deepEqual(await readSettlementNode("getTxByHash", { hash: missing }), { notFound: true, checkedThroughBlock: 2594 });
    // The node had checked through block 2594: a transfer cited in a later block is not decided yet,
    // one cited at or below it does not exist.
    assert.equal(await verifyNativePayment({ txHash: missing, blockNumber: 548169 }, agreed, 2, readSettlementNode), "indeterminate");
    assert.equal(await verifyNativePayment({ txHash: missing, blockNumber: 2594 }, agreed, 2, readSettlementNode), "fail");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Daybreak P1-2: every non-answer used to read as null, so a node outage looked like a missing transfer.
test("the production node reader returns only answers and throws, with the cause, on anything else", async () => {
  const { readSettlementNode } = await import("../src/catalog/chain.js");
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const originalFetch = globalThis.fetch;
  const reply = async (respond: () => Response) => {
    globalThis.fetch = async () => respond();
    try { return { value: await readSettlementNode("getTxByHash", { hash: "ab".repeat(32) }) }; } catch (error) {
      assert.ok(error instanceof VerificationUnavailable, String(error));
      // Every reply the reader cannot use is no answer about the transaction, never a lasting state.
      assert.equal(error.kind, "no-answer");
      return { unavailable: (error as Error).message };
    }
  };
  try {
    assert.deepEqual(await reply(() => json({ result: 200, response: { hash: "ab".repeat(32) } })), { value: { hash: "ab".repeat(32) } });
    assert.deepEqual(await reply(() => json({ result: 404, response: null, extra: { reason: "not_found", checkedThroughBlock: 7 } })),
      { value: { notFound: true, checkedThroughBlock: 7 } });
    for (const [name, respond, cause] of [
      ["a result 200 without a response", () => json({ result: 200, response: null }), "the node's getTxByHash reply has no answer (result 200)"],
      ["a result 500", () => json({ result: 500, response: "error" }), "the node's getTxByHash reply has no answer (result 500)"],
      ["the pinned source's 400", () => json({ result: 400, response: "error" }), "the node's getTxByHash reply has no answer (result 400)"],
      ["a 404 without a reason", () => json({ result: 404, response: null }), "the node's getTxByHash reply has no answer (result 404)"],
      ["a 404 with another reason", () => json({ result: 404, response: null, extra: { reason: "pruned", checkedThroughBlock: 7 } }), "the node's getTxByHash reply has no answer (result 404)"],
      ["a 404 without a block", () => json({ result: 404, response: null, extra: { reason: "not_found" } }), "the node's getTxByHash reply has no answer (result 404)"],
      ["a non-numeric result", () => json({ result: "200", response: {} }), "the node's getTxByHash reply has no answer (result not a status)"],
      ["HTTP 502", () => new Response("bad gateway", { status: 502 }), "the node's getTxByHash reply failed (HTTP 502)"],
      ["not JSON", () => new Response("<html>"), "the node's getTxByHash reply is not JSON"],
      ["a transport failure", () => { throw new TypeError("fetch failed"); }, "the node's getTxByHash reply failed (transport)"],
      ["a timeout", () => { throw new DOMException("timed out", "TimeoutError"); }, "the node's getTxByHash reply failed (timeout)"],
    ] as Array<[string, () => Response, string]>) {
      assert.deepEqual(await reply(respond), { unavailable: cause }, name);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
