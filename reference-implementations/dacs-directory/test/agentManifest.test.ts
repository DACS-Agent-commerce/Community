import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentMarketManifest } from "../src/catalog/agentManifest.js";
import type { Catalog } from "../src/catalog/types.js";

test("agent manifest exposes real market operations without claiming negotiation is live", () => {
  const catalog: Catalog = {
    catalogVersion: "1",
    generatedAt: 123,
    sellers: [{
      primaryClaim: `did:demos:agent:${"a".repeat(64)}`,
      displayName: "Seller",
      cci: [],
      deals: [],
      reputation: { completed: 0, totalAgreements: 0, completionRate: null },
      registeredAt: 1,
      lastIndexedAt: 2,
      listings: [{
        listingId: "research",
        version: 1,
        contentHash: "b".repeat(64),
        anchor: { kind: "storage-program", locator: `stor-${"c".repeat(40)}` },
        seller: { primaryClaim: `did:demos:agent:${"a".repeat(64)}`, displayName: "Seller" },
        offering: {
          title: "Research",
          category: "services.research",
          tags: [],
          rails: ["pay-x402"],
          delivery: ["deliver-attested-payload"],
          negotiation: ["negotiate-fixed-price"],
        },
        pricing: { priceHint: "2", currency: "USDC" },
        status: "active",
        catalogObservedAt: 3,
      }],
    }],
  };

  const manifest = buildAgentMarketManifest("https://market.example", catalog);
  assert.equal(manifest.catalog.endpoint, "https://market.example/api/dacs/listings");
  assert.equal(manifest.catalog.listingCount, 1);
  assert.equal(manifest.endpoints.listing, "https://market.example/api/dacs/listings/{listingId}/{version}");
  assert.deepEqual(manifest.capabilities.paymentRails, ["pay-x402"]);
  assert.equal(manifest.operations.discover.status, "available");
  assert.equal(manifest.operations.negotiate.status, "planned");
});
