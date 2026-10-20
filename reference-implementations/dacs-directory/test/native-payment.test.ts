import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { demOs, verifyNativePayment } from "../src/catalog/nativePayment.js";

// Read-only node2 captures from 2026-10-17, retained byte-for-byte.
const captured = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/native-payment/${name}.json`, import.meta.url), "utf8")).response;
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
  assert.equal(await check(tx, { ...block, number: tx.blockNumber + 1 }), "fail");
});

test("only a native send operation settles the agreement", async () => {
  for (const nativeOperation of ["transfer", "Send", "", undefined]) {
    const changed = structuredClone(tx);
    changed.content.data[1].nativeOperation = nativeOperation;
    assert.equal(await check(changed), "fail", String(nativeOperation));
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
