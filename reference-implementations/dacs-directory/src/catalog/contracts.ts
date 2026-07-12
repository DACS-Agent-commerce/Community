export const listingSummarySchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "/schemas/listing-summary.schema.json",
  title: "DACS Directory ListingSummary",
  type: "object",
  required: ["listingId", "version", "contentHash", "anchor", "seller", "offering", "pricing", "status", "catalogObservedAt"],
  properties: {
    listingId: { type: "string", minLength: 1 },
    version: { type: "integer", minimum: 1 },
    contentHash: { type: "string", minLength: 1 },
    anchor: {
      type: "object", required: ["kind", "locator"], additionalProperties: false,
      properties: { kind: { type: "string" }, locator: { type: "string" } },
    },
    seller: {
      type: "object", required: ["primaryClaim", "displayName"], additionalProperties: false,
      properties: { primaryClaim: { type: "string" }, displayName: { type: "string" } },
    },
    artifactProfile: { enum: ["dacs-v0.1", "legacy-sdk-v0.1"] },
    publicEndpoint: { type: "string", format: "uri" },
    offering: {
      type: "object", required: ["title", "category", "tags"],
      properties: {
        title: { type: "string" }, description: { type: "string" }, category: { type: "string" },
        tags: { type: "array", items: { type: "string" } }, rails: { type: "array", items: { type: "string" } },
        delivery: { type: "array", items: { type: "string" } }, negotiation: { type: "array", items: { type: "string" } },
        deliverable: { type: "object" },
      },
    },
    pricing: {
      type: "object", properties: {
        kind: { enum: ["fixed", "negotiable", "auction"] }, priceHint: { type: "string" },
        currency: { type: "string" }, unit: { type: "string" }, minPct: { type: "number" },
        maxPct: { type: "number" }, selectionRule: { type: "string" },
      },
    },
    status: { enum: ["active", "revoked"] },
    catalogObservedAt: { type: "integer" },
    reputationHint: { type: "object" },
  },
} as const;

export const directoryManifest = (origin: string) => ({
  name: "DACS Directory",
  description: "A discovery catalog for signed, chain-anchored DACS agent services.",
  dacsDirectoryVersion: "1",
  humanUrl: origin,
  agentCard: `${origin}/.well-known/agent.json`,
  api: `${origin}/api/dacs`,
  catalog: `${origin}/api/dacs/listings`,
  openapi: `${origin}/openapi.json`,
  schemas: { listingSummary: `${origin}/schemas/listing-summary.schema.json` },
  status: `${origin}/api/dacs/status`,
  artifactProfiles: {
    current: "dacs-v0.1",
    compatibility: "legacy-sdk-v0.1",
    missingProfileMeans: "legacy-sdk-v0.1",
  },
  maturity: {
    listings: "current publisher and dual-profile reader",
    identityTier: "self-declared unless a fresh DACS-2 verifiedBy result is resolved",
    reputation: "DACS-5 two-copy reconciliation with ratings, volume, SR-2 windows, and deterministic receipts",
  },
  verification: {
    policy: "strict party signatures plus referenced-artifact signature/hash checks",
    limitation: "RPC bytes pass through the directory server; client verification proves internal consistency, not independent chain inclusion.",
  },
  filters: ["category", "tag", "credential", "primaryClaim", "identityTier", "rail", "priceMax", "minCompletionRate", "minRating", "q", "profile", "limit", "cursor"],
});

export const openApiDocument = (origin: string) => ({
  openapi: "3.1.0",
  info: {
    title: "DACS Directory API",
    version: "1.0.0",
    description: "Discover DACS services and retrieve the signed chain artifacts behind them.",
  },
  servers: [{ url: origin }],
  paths: {
    "/api/dacs": { get: { summary: "API index", responses: { "200": { description: "Linked API capabilities" } } } },
    "/api/dacs/listings": {
      get: {
        summary: "Search active services",
        parameters: [
          { name: "category", in: "query", schema: { type: "string" } },
          { name: "tag", in: "query", schema: { type: "array", items: { type: "string" } }, style: "form", explode: true },
          { name: "rail", in: "query", schema: { type: "string" } },
          { name: "credential", in: "query", schema: { type: "string" } },
          { name: "primaryClaim", in: "query", schema: { type: "string" } },
          { name: "identityTier", in: "query", schema: { enum: ["institutional", "verified", "self-declared"] } },
          { name: "priceMax", in: "query", schema: { type: "number", minimum: 0 } },
          { name: "minCompletionRate", in: "query", schema: { type: "number", minimum: 0, maximum: 1 } },
          { name: "minRating", in: "query", schema: { type: "number", minimum: 0, maximum: 5 } },
          { name: "q", in: "query", description: "Directory full-text search extension", schema: { type: "string" } },
          { name: "profile", in: "query", description: "Artifact compatibility profile", schema: { enum: ["dacs-v0.1", "legacy-sdk-v0.1"] } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 } },
          { name: "cursor", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "A cursor-paginated listing page" }, "400": { description: "Invalid pagination" } },
      },
    },
    "/api/dacs/listings/{listingId}/{version}": {
      get: {
        summary: "Retrieve and re-verify a listing artifact",
        parameters: [
          { name: "listingId", in: "path", required: true, schema: { type: "string" } },
          { name: "version", in: "path", required: true, schema: { type: "integer" } },
          { name: "seller", in: "query", description: "Disambiguates seller-scoped listing IDs", schema: { type: "string" } },
        ],
        responses: { "200": { description: "Signed listing artifact" }, "404": { description: "Listing not found" }, "502": { description: "Anchor verification failed" } },
      },
    },
    "/api/dacs/sellers/{primaryClaimRef}": {
      get: {
        summary: "Retrieve seller identity, services, reputation hints, and deals",
        parameters: [{ name: "primaryClaimRef", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Seller view" }, "404": { description: "Seller not found" } },
      },
    },
    "/api/dacs/status": { get: { summary: "Catalog freshness", responses: { "200": { description: "Indexer and chain-tip state" } } } },
  },
  components: { schemas: { ListingSummary: listingSummarySchema } },
});
