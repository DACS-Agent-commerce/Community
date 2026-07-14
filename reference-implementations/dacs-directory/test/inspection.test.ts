import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDirectoryServiceInspectionEnvelope,
  directoryInspectionAffordance,
  inspectServicePath,
  withDirectoryInspectionAffordance,
} from "../src/catalog/inspection.js";
import type { ListingSummary } from "../src/catalog/types.js";

const listing: ListingSummary = {
  listingId: "dependency-upgrade-plan",
  version: 1,
  contentHash: "3".repeat(64),
  anchor: {
    kind: "storage-program",
    locator: "dacs1:listing:dependency-upgrade-plan:v1",
  },
  seller: {
    primaryClaim: "did:demos:agent:directory-sample-demo",
    displayName: "Dependency Upgrade Desk",
  },
  artifactProfile: "dacs-v0.1",
  offering: {
    title: "Dependency upgrade plan",
    description: "Sample listing for inspection envelope tests.",
    category: "services.dependency-upgrade",
    tags: ["dependencies", "upgrade"],
    rails: ["pay-x402"],
    delivery: ["deliver-storage-program"],
    negotiation: ["negotiate-fixed-price"],
  },
  pricing: {},
  status: "active",
  catalogObservedAt: 1784016000000,
};

test("directory inspection affordance points at a verifier service profile envelope", () => {
  const affordance = directoryInspectionAffordance(listing);

  assert.equal(affordance.artifactType, "directory-service-profile");
  assert.equal(affordance.maturity, "listed");
  assert.equal(
    affordance.href,
    "/api/dacs/inspect-service/dependency-upgrade-plan/1?seller=did%3Ademos%3Aagent%3Adirectory-sample-demo",
  );
});

test("directory service profile envelope is listed-only and does not claim source truth, payment, or reputation", () => {
  const envelope = buildDirectoryServiceInspectionEnvelope("https://directory.example", listing);

  assert.equal(envelope.artifactType, "directory-service-profile");
  assert.equal(envelope.source.kind, "directory-api");
  assert.equal(envelope.source.url, `https://directory.example${inspectServicePath(listing)}`);
  assert.equal(envelope.expectations.listingId, "dependency-upgrade-plan");
  assert.equal(envelope.expectations.listingVersion, 1);
  assert.equal(envelope.expectations.expectedMaturity, "listed");

  assert.equal(envelope.artifact.profileKind, "directory-service-profile");
  assert.equal(envelope.artifact.profileVersion, "0.1");
  assert.equal(envelope.artifact.listing.listingId, "dependency-upgrade-plan");
  assert.equal(envelope.artifact.listing.version, 1);
  assert.equal(envelope.artifact.listing.seller, "did:demos:agent:directory-sample-demo");
  assert.equal(envelope.artifact.maturityProfile.maturity, "listed");
  assert.equal(envelope.artifact.maturityProfile.noReputationClaim, true);
  assert.equal(envelope.artifact.maturityProfile.noLivePaymentClaim, true);
  assert.deepEqual(envelope.artifact.limitations, [
    "roster maturity hint",
    "not reputation evidence",
    "not source truth",
  ]);
});

test("listing discovery can add the inspection affordance without changing the signed listing fields", () => {
  const withInspection = withDirectoryInspectionAffordance(listing);

  assert.notEqual(withInspection, listing);
  assert.equal(withInspection.listingId, listing.listingId);
  assert.equal(withInspection.contentHash, listing.contentHash);
  assert.equal(withInspection.anchor.locator, listing.anchor.locator);
  assert.equal(withInspection.inspection?.artifactType, "directory-service-profile");
  assert.equal(withInspection.inspection?.href, inspectServicePath(listing));
  assert.equal(listing.inspection, undefined);
});
