import { SETTLEMENT_PROJECTION_VERSION } from "../../src/catalog/settlementUniqueness.js";
import type { Catalog, DealRecord, SellerRecord } from "../../src/catalog/types.js";

export const noRateClaim = `did:demos:agent:${"a".repeat(64)}`;
export const noRateOutcomes = [
  "completed", "failed-perm", "failed-counterparty", "failed-substrate",
  "aborted-by-self", "aborted-by-other",
];

export function noRateCatalog(): Catalog {
  const deals: DealRecord[] = noRateOutcomes.map((outcome, index) => ({
    jobId: `observed-${index}`,
    rail: "pay-dem",
    buyerBundleRef: `stor-${String(index + 1).repeat(40)}`,
    sellerBundleRef: `stor-${String(index + 2).repeat(40)}`,
    owners: { buyer: `did:demos:agent:${"b".repeat(64)}`, seller: noRateClaim },
    signatureVerified: true,
    refsVerified: true,
    reputationEligible: true,
    settlementProjectionVersion: SETTLEMENT_PROJECTION_VERSION,
    anchoredByRole: "buyer",
    ...(outcome === "completed" ? { agreementPrice: { amount: "2", currency: "DEM" } } : {}),
    outcome,
    sellerOutcome: outcome,
    finalisedAt: 100 + index,
    verifiedAt: 200,
    category: "services.test",
    bundleContentHash: String(index + 1).repeat(64),
    ratings: [{
      rater: `did:demos:agent:${"b".repeat(64)}`, target: noRateClaim,
      targetRole: "seller", value: 5, ratedAt: 150, contentHash: "c".repeat(64),
    }],
  }));
  const seller: SellerRecord = {
    primaryClaim: noRateClaim,
    displayName: "Observed History Service",
    cci: [],
    registeredAt: 1,
    lastIndexedAt: 200,
    listings: [{
      listingId: "observed-history", version: 1, contentHash: "d".repeat(64),
      anchor: { kind: "storage-program", locator: `stor-${"9".repeat(40)}` },
      seller: { primaryClaim: noRateClaim, displayName: "Observed History Service" },
      artifactProfile: "dacs-v0.1",
      offering: { title: "Observed history inspection", category: "services.test", tags: ["history"], rails: ["pay-dem"] },
      pricing: { kind: "fixed", priceHint: "2", currency: "DEM" },
      status: "active", catalogObservedAt: 200,
      // Deliberately stale numeric metrics exercise reads before any reindex.
      reputationHint: {
        categoryScope: "services.test", completionRate: 0.95, averageSellerRating: 5,
        bundleCount: deals.length, windowStart: 0, windowEnd: 200, computedAt: 200,
      },
    }],
    deals,
    reputation: {
      completed: 1, totalAgreements: deals.length, bundleCount: deals.length,
      completionRate: 0.95, counterpartyAdjustedCompletionRate: 1,
      counterpartyFaultRate: 0.25, averageBuyerRating: 4, averageSellerRating: 5,
      observedTransactionalVolume: [{ currency: "DEM", amount: "2" }],
      transactionCountByCurrency: [{ currency: "DEM", count: 1 }],
      bundleRefs: deals.map((deal) => ({
        kind: "dacs-5-bundle", id: deal.jobId, contentHash: deal.bundleContentHash!,
        anchor: { kind: "storage-program", locator: deal.buyerBundleRef },
      })),
    },
  };
  return { catalogVersion: "1", generatedAt: 200, sellers: [seller] };
}
