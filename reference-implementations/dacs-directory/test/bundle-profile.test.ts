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

test("phase-only current references win over an otherwise historical agreement", () => {
  for (const anchor of [current.anchor, null]) {
    assert.equal(usesCurrentBundleProfile({ bundleVersion: "1", agreementRef: legacy,
      phaseSummary: [{ attestationRef: { anchor, contentHash: current.contentHash } }] }), true);
  }
});

test("incomplete historical references select current and malformed phase rows do not throw", () => {
  for (const agreementRef of [{ kind: legacy.kind }, { id: legacy.id }, {}]) {
    assert.equal(usesCurrentBundleProfile({ bundleVersion: "1", agreementRef }), true);
  }
  assert.equal(usesCurrentBundleProfile({ bundleVersion: "1", agreementRef: legacy,
    phaseSummary: [null, false, 7, "phase", []] }), false);
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

test("fault fields select current whatever their value, so mixed bundles never reach the historical reader", () => {
  for (const raw of [
    { bundleVersion: "1", faultBundleVersion: "2", agreementRef: legacy },
    { bundleVersion: "1", faultedParty: "buyer", agreementRef: legacy },
    { bundleVersion: "1", faultBundleVersion: null, faultedParty: null, agreementRef: legacy },
  ]) assert.equal(usesCurrentBundleProfile(raw), true, JSON.stringify(raw));
});
