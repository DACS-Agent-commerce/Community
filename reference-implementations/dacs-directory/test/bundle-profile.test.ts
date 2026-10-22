import assert from "node:assert/strict";
import test from "node:test";
import { usesCurrentBundleProfile } from "../src/catalog/bundleProfile.js";

const legacy = { kind: "dacs-3-agreement", id: "agreement-job", contentHash: "a".repeat(64) };
const current = { anchor: { kind: "storage-program", locator: "stor-anchor" }, contentHash: "a".repeat(64) };

test("explicit legacy references select the historical reader independently of signature validity", () => {
  for (const signatures of [undefined, [], [{ value: "invalid" }]]) {
    assert.equal(usesCurrentBundleProfile({ bundleVersion: "1", agreementRef: legacy, signatures }), false);
  }
  assert.equal(usesCurrentBundleProfile(null), false);
});

test("current and mixed reference formats never fall back to legacy on malformed data", () => {
  for (const raw of [
    { bundleVersion: "1", agreementRef: current },
    { bundleVersion: "1", agreementRef: { ...legacy, anchor: null } },
    { bundleVersion: "1", agreementRef: legacy, settlementEvidence: [current] },
    { bundleVersion: "1", agreementRef: legacy, ratingRefs: [] },
    { bundleVersion: "1", agreementRef: legacy, amendments: [] },
    { bundleVersion: "1" },
    { faultBundleVersion: "1", agreementRef: legacy },
  ]) assert.equal(usesCurrentBundleProfile(raw), true, JSON.stringify(raw));
});
