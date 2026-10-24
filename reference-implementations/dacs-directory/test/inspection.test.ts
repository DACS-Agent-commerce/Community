import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET as inspectServiceGet } from "../app/api/dacs/inspect-service/[listingId]/[version]/route.js";
import { GET as listingContractGet } from "../app/api/dacs/listings/[listingId]/[version]/route.js";
import { counterpartyEvidenceSellerRecord } from "../src/catalog/counterpartyEvidence.js";
import { saveCatalog } from "../src/catalog/store.js";
import { generateMetadata as serviceMetadata } from "../app/service/[seller]/[listingId]/[version]/page.js";

import {
  buildDirectoryServiceInspectionEnvelope,
  buildDirectoryServiceProfile,
  directoryInspectionAffordance,
  inspectServicePath,
  listingJsonPath,
  servicePath,
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

test("inspection route refuses missing or blank seller lookup keys", async () => {
  for (const suffix of ["", "?seller=%20%20"]) {
    const response = await inspectServiceGet(
      new NextRequest(`https://directory.example/api/dacs/inspect-service/shared-listing/1${suffix}`),
      { params: Promise.resolve({ listingId: "shared-listing", version: "1" }) },
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "seller is required" });
  }
});

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
  assert.equal(envelope.maturity, "listed");
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
  assert.match(envelope.artifact.maturityProfile.reason, /separate verifier adapters/);
  assert.equal(envelope.maturity, envelope.artifact.maturityProfile.maturity);
  assert.equal(envelope.artifact.maturityProfile.noReputationClaim, true);
  assert.equal(envelope.artifact.maturityProfile.noLivePaymentClaim, true);
  assert.equal(envelope.artifact.transactionReadiness.disposition, "unassessed");
  assert.match(envelope.artifact.transactionReadiness.reason, /buyer-local/);
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
  assert.equal(withInspection.transactionReadiness?.disposition, "unassessed");
  assert.equal(listing.inspection, undefined);
});

test("inspection preserves all service fields and canonical seller links with either artifact profile", () => {
  const seller = `did:demos:agent:${"ab".repeat(32)}`;
  const encodedSeller = `did%3Ademos%3Aagent%3A${"ab".repeat(32)}`;
  for (const explicit of [true, false]) {
    const candidate = structuredClone(listing);
    candidate.listingId = "service/name";
    candidate.seller.primaryClaim = `${seller}?channel=directory`;
    if (!explicit) {
      delete candidate.artifactProfile;
      delete candidate.offering.rails;
      delete candidate.offering.delivery;
      delete candidate.offering.negotiation;
    }
    const envelope = buildDirectoryServiceInspectionEnvelope("https://directory.example", candidate);
    assert.equal(envelope.artifact.listing.artifactProfile, explicit ? "dacs-v0.1" : "legacy-sdk-v0.1");
    assert.equal(envelope.artifact.listing.seller, `${seller}?channel=directory`, "signed reference bytes are retained");
    assert.deepEqual(envelope.artifact.service, {
      title: "Dependency upgrade plan", category: "services.dependency-upgrade", tags: ["dependencies", "upgrade"],
      rails: explicit ? ["pay-x402"] : [], delivery: explicit ? ["deliver-storage-program"] : [],
      negotiation: explicit ? ["negotiate-fixed-price"] : [],
    });
    assert.deepEqual(envelope.artifact.links, {
      listingJson: `https://directory.example/api/dacs/listings/service%2Fname/1?seller=${encodedSeller}`,
      servicePage: `https://directory.example/service/${encodedSeller}/service%2Fname/1`,
    });
    assert.equal(envelope.source.url,
      `https://directory.example/api/dacs/inspect-service/service%2Fname/1?seller=${encodedSeller}`);
  }
});

test("both listing routes resolve the canonical seller link of a summary whose claim carries parameters", async () => {
  const seller = `did:demos:agent:${"ab".repeat(32)}`;
  const record = counterpartyEvidenceSellerRecord(1);
  const qualified = { ...record.listings[0], seller: { ...record.listings[0].seller, primaryClaim: `${seller}?channel=directory` } };
  saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [{ ...record, primaryClaim: seller, listings: [qualified] }] });
  const params = Promise.resolve({ listingId: qualified.listingId, version: String(qualified.version) });
  assert.match(inspectServicePath(qualified), new RegExp(`seller=${encodeURIComponent(seller)}$`));
  for (const [get, href] of [[inspectServiceGet, inspectServicePath(qualified)], [listingContractGet, listingJsonPath(qualified)]] as const) {
    const response = await get(new NextRequest(`https://directory.example${href}`), { params });
    assert.equal(response.status, 200, href);
  }
  const exact = await inspectServiceGet(
    new NextRequest(`https://directory.example/api/dacs/inspect-service/${qualified.listingId}/${qualified.version}?seller=${encodeURIComponent(qualified.seller.primaryClaim)}`), { params });
  assert.equal(exact.status, 200, "the exact stored claim still finds it");
});

test("the readiness reason makes no authentication claim, so it holds for an unsigned fixture listing too", () => {
  const fixture = counterpartyEvidenceSellerRecord(0).listings[0];
  assert.equal(fixture.artifactProfile, "fixture-listing");
  assert.equal(fixture.transactionReadiness?.disposition, "unassessed");
  assert.doesNotMatch(fixture.transactionReadiness?.reason ?? "", /authenticated|SDK/);
  const profile = buildDirectoryServiceProfile("https://directory.example", fixture);
  assert.doesNotMatch(profile.maturityProfile.reason, /authenticated/, "the maturity reason makes no authentication claim either");
});

test("the listing route links the canonical seller identity, and the service page resolves that link", async () => {
  const seller = `did:demos:agent:${"ab".repeat(32)}`;
  const record = counterpartyEvidenceSellerRecord(1);
  const qualified = { ...record.listings[0], seller: { ...record.listings[0].seller, primaryClaim: `${seller}?channel=directory` } };
  saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [{ ...record, primaryClaim: seller, listings: [qualified] }] });
  const response = await listingContractGet(
    new NextRequest(`https://directory.example${listingJsonPath(qualified)}`),
    { params: Promise.resolve({ listingId: qualified.listingId, version: String(qualified.version) }) });
  const link = (rel: string) => (response.headers.get("link") ?? "").split(", ")
    .find((entry) => entry.includes(`rel="${rel}"`))?.match(/<([^>]+)>/)?.[1];
  assert.equal(link("alternate"), `https://directory.example${servicePath(qualified)}`);
  assert.equal(link("seller"), `https://directory.example/api/dacs/sellers/${encodeURIComponent(seller)}`);
  const page = await serviceMetadata({ params: Promise.resolve({
    seller: encodeURIComponent(seller), listingId: qualified.listingId, version: String(qualified.version) }) });
  assert.equal(page.title, qualified.offering.title);
  const alsoQualified = await serviceMetadata({ params: Promise.resolve({
    seller: encodeURIComponent(`${seller}?channel=directory`), listingId: qualified.listingId, version: String(qualified.version) }) });
  assert.equal(alsoQualified.title, qualified.offering.title, "a link built from the exact stored claim still resolves");
});
