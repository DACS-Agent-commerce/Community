import assert from "node:assert/strict";
import test from "node:test";

import {
  chainResetRequired,
  chainResetThreshold,
  cursorAheadBy,
} from "../src/catalog/chainContinuity.js";

test("a single low-tip observation waits for corroboration", () => {
  const state = { lastSeenTxId: 147_262, lastChainTip: 147_264 };
  assert.equal(cursorAheadBy(state, 27_195), 120_067);
  assert.equal(chainResetRequired(state, 27_195, 1_000), false);
});

test("two low-tip observations require a cache rebuild", () => {
  const state = { lastSeenTxId: 147_262, lastChainTip: 31_698 };
  assert.equal(chainResetRequired(state, 31_792, 1_000), true);
});

test("normal finality lag and small node divergence do not clear the cache", () => {
  assert.equal(chainResetRequired({ lastSeenTxId: 100, lastChainTip: 102 }, 102, 1_000), false);
  assert.equal(chainResetRequired({ lastSeenTxId: 10_000, lastChainTip: 10_002 }, 9_990, 1_000), false);
  assert.equal(cursorAheadBy({ lastSeenTxId: 100 }, 102), 0);
});

test("a prior chain tip corroborates the replacement decision", () => {
  assert.equal(chainResetRequired({ lastSeenTxId: 10_000, lastChainTip: 500 }, 400, 1_000), true);
  assert.equal(chainResetRequired({ lastSeenTxId: 10_000, lastChainTip: 9_500 }, 400, 1_000), false);
  assert.equal(chainResetRequired({ lastSeenTxId: 10_000 }, 400, 1_000), true);
});

test("reset threshold is bounded to a safe positive integer", () => {
  assert.equal(chainResetThreshold("250"), 250);
  assert.equal(chainResetThreshold("0"), 1_000);
  assert.equal(chainResetThreshold("not-a-number"), 1_000);
});
