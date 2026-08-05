import assert from "node:assert/strict";
import test from "node:test";
import { directoryEvidenceState, UNMEASURED_REACHABILITY_LABEL } from "../src/components/directory-evidence-state.js";
import type { ListingSummary, SellerRecord } from "../src/catalog/types.js";

const listing = (overrides: Partial<ListingSummary> = {}): ListingSummary => ({
  listingId: "service",
  version: 1,
  contentHash: "a".repeat(64),
  anchor: { kind: "storage-program", locator: "stor-listing" },
  seller: { primaryClaim: "key:seller", displayName: "Seller" },
  artifactProfile: "dacs-v0.1",
  offering: { title: "Service", category: "services.other", tags: [] },
  pricing: {},
  status: "active",
  catalogObservedAt: 1,
  ...overrides,
});

const seller = (completed = 0, totalAgreements = 0): Pick<SellerRecord, "identityTier" | "reputation"> => ({
  identityTier: "verified",
  reputation: { completed, totalAgreements, completionRate: totalAgreements ? completed / totalAgreements : null },
});

test("separates listing evidence, endpoint declaration, and unmeasured reachability", () => {
  const state = directoryEvidenceState(listing({ publicEndpoint: "https://agent.example/jobs" }), seller(2, 3));
  assert.deepEqual(state.listing, { kind: "current", label: "current DACS listing" });
  assert.deepEqual(state.endpoint, {
    kind: "declared",
    label: "Declared HTTPS endpoint",
    explanation: "A safe HTTPS contact route is declared in the listing",
    url: "https://agent.example/jobs",
  });
  assert.deepEqual(state.reachability, { kind: "not-measured", label: UNMEASURED_REACHABILITY_LABEL });
  assert.equal(state.identityTier, "verified");
  assert.equal(state.deals.label, "2 strict-verified / 3 agreements");
  assert.match(state.deals.explanation, /Both parties/);
});

test("does not turn a missing endpoint into a service failure", () => {
  const state = directoryEvidenceState(listing({ publicEndpoint: undefined }), seller());
  assert.deepEqual(state.endpoint, {
    kind: "not-declared",
    label: "No endpoint declared",
    explanation: "The listing declares no engagement endpoint",
  });
  assert.equal(state.reachability.label, "Not measured by Directory");
  assert.equal(state.deals.label, "0 strict-verified / 0 agreements");
  assert.equal(state.deals.explanation, "No verified two-sided bundle history yet");
});

test("distinguishes unsafe declarations without exposing or linking them", () => {
  for (const publicEndpoint of ["http://agent.example", "https://alice@agent.example"]) {
    const state = directoryEvidenceState(listing({ publicEndpoint }), seller());
    assert.deepEqual(state.endpoint, {
      kind: "unsafe-declaration",
      label: "Endpoint declaration not shown",
      explanation: "The declared endpoint is not a safe HTTPS URL and is not linked",
    });
    assert.equal(state.reachability.label, "Not measured by Directory");
  }
});

test("keeps fixture and legacy listing evidence visibly distinct", () => {
  assert.deepEqual(
    directoryEvidenceState(listing({ anchor: { kind: "fixture", locator: "fixture://service" }, artifactProfile: "fixture-listing" }), seller()).listing,
    { kind: "fixture", label: "fixture listing" },
  );
  assert.deepEqual(
    directoryEvidenceState(listing({ artifactProfile: "legacy-sdk-v0.1" }), seller()).listing,
    { kind: "legacy", label: "legacy SDK listing" },
  );
});
