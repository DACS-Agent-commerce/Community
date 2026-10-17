import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { verifyNativePayment } from "../src/catalog/nativePayment.js";

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
