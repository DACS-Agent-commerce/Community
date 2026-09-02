import assert from "node:assert/strict";
import test from "node:test";

import { indexReason, type IndexDecisionInput } from "../src/catalog/liveIndexer.js";

const base = (overrides: Partial<IndexDecisionInput> = {}): IndexDecisionInput => ({
  now: 1_000_000,
  chainLatestTx: 100,
  cursor: 100,
  catalogGeneratedAt: 900_000,
  inputsModifiedAt: 800_000,
  lastCompletedAt: 900_000,
  hasIndeterminateAnchors: false,
  retryIntervalMs: 30_000,
  fullRefreshIntervalMs: 300_000,
  ...overrides,
});

test("live indexer wakes for chain and local discovery-input changes", () => {
  assert.equal(indexReason(base({ chainLatestTx: 101 })), "chain");
  assert.equal(indexReason(base({ inputsModifiedAt: 900_001 })), "inputs");
});

test("live indexer periodically retries indeterminate anchors", () => {
  assert.equal(indexReason(base({
    hasIndeterminateAnchors: true,
    lastCompletedAt: 969_999,
  })), "retry");
});

test("live indexer stays idle when the cursor and inputs are current", () => {
  assert.equal(indexReason(base()), null);
});

test("initial and maintenance passes cannot be skipped", () => {
  assert.equal(indexReason(base({ catalogGeneratedAt: 0 })), "initial");
  assert.equal(indexReason(base({ lastCompletedAt: 699_999 })), "maintenance");
});
