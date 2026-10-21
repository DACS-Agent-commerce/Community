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

// Code F-A: a card must not present a partial record as complete. Undecided sessions are counted on the label and
// the completion rate is the range they leave, never a newcomer's "no history yet".
test("a seller with undecided sessions shows their count and the completion rate's range", () => {
  const partial = (completed: number, total: number, undecidedSessions: number, low: number | null, high: number | null) =>
    directoryEvidenceState(listing(), { identityTier: "verified", reputation: { completed, totalAgreements: total, completionRate: null,
      undecidedSessions, completionRateRange: { low, high } } }).deals;
  assert.deepEqual(partial(0, 1, 100, 0, 100 / 101), {
    completed: 0, total: 1, label: "0 strict-verified / 1 agreement · 100 undecided",
    explanation: "100 sessions this pass could not decide count neither as completed nor as failed, so the completion rate is between 0% and 99%",
  });
  assert.equal(partial(0, 0, 1, null, 1).explanation,
    "1 session this pass could not decide counts neither as completed nor as failed, so no completion rate is verified yet; it is at most 100%");
  assert.equal(directoryEvidenceState(listing(), seller()).deals.explanation, "No verified two-sided bundle history yet");
});

test("projects fresh and stale bounded probes through the evidence boundary", () => {
  const now = 2_000_000_000_000;
  const reachable = directoryEvidenceState(listing({
    publicEndpoint: "https://agent.example/jobs",
    reachabilityHint: { status: "reachable", checkedAt: now, surface: "https://agent.example/jobs" },
  }), seller(), now);
  assert.deepEqual(reachable.reachability, {
    kind: "reachable",
    label: "Reachable in latest bounded Directory probe",
  });

  const unreachable = directoryEvidenceState(listing({
    publicEndpoint: "https://agent.example/jobs",
    reachabilityHint: { status: "unreachable", checkedAt: now, surface: "https://agent.example/jobs" },
  }), seller(), now);
  assert.deepEqual(unreachable.reachability, {
    kind: "unreachable",
    label: "Unreachable in latest bounded Directory probe",
  });

  const stale = directoryEvidenceState(listing({
    publicEndpoint: "https://agent.example/jobs",
    reachabilityHint: { status: "reachable", checkedAt: now - 60 * 60_000 - 1, surface: "https://agent.example/jobs" },
  }), seller(), now);
  assert.deepEqual(stale.reachability, {
    kind: "unknown",
    label: "Not recently confirmed by Directory",
  });
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
