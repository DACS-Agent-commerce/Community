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

export const deadLetterDiagnosticSchema = {
  type: "object",
  additionalProperties: false,
  required: ["locator", "kind", "classification", "code", "message", "attempts", "firstSeenAt", "lastSeenAt", "retryState"],
  properties: {
    locator: { type: "string", pattern: "^stor-[0-9a-f]{40}$" },
    kind: { type: "string" },
    classification: { enum: ["dacs-artifact", "unclassified-storage"] },
    code: { type: "string", description: "Stable public-safe failure code; internal errors are not exposed." },
    message: { type: "string", description: "Public-safe remediation guidance, never a raw exception or payload." },
    attempts: { type: "integer", minimum: 1 },
    firstSeenAt: { type: "integer" },
    lastSeenAt: { type: "integer" },
    retryState: { const: "exhausted" },
  },
} as const;

export const indexerScanRunSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "started_at", "finished_at", "from_tx", "to_tx", "chain_tip", "txs_scanned", "artifacts_observed", "rejected", "status"],
  properties: {
    id: { type: "integer", minimum: 1 },
    started_at: { type: "integer", minimum: 0 },
    finished_at: { type: ["integer", "null"], minimum: 0 },
    from_tx: { type: "integer", minimum: 0 },
    to_tx: { type: ["integer", "null"], minimum: 0 },
    chain_tip: { type: ["integer", "null"], minimum: 0 },
    txs_scanned: { type: "integer", minimum: 0 },
    artifacts_observed: { type: "integer", minimum: 0 },
    rejected: { type: "integer", minimum: 0 },
    status: { enum: ["running", "complete", "failed"] },
  },
} as const;

export const catalogStatusSchema = {
  type: "object",
  required: ["generatedAt", "syncedToTx", "chainLatestTx", "txsBehind", "indexer"],
  properties: {
    generatedAt: { type: "integer" },
    syncedToTx: { type: "integer" },
    chainLatestTx: { type: ["integer", "null"] },
    txsBehind: { type: ["integer", "null"] },
    indexer: {
      type: "object",
      required: ["storage", "artifacts", "deadLetters", "deadLetterDiagnostics", "lastRun"],
      properties: {
        storage: { const: "sqlite-wal" },
        artifacts: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
        deadLetters: { type: "integer", minimum: 0 },
        deadLetterDiagnostics: {
          type: "object",
          required: ["scope", "total", "byCode", "byKind", "query", "returned", "hasMore", "items"],
          properties: {
            scope: { const: "storage-read" },
            total: { type: "integer", minimum: 0 },
            byCode: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
            byKind: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
            query: {
              type: "object", required: ["locator", "limit"], additionalProperties: false,
              properties: {
                locator: { type: ["string", "null"], pattern: "^stor-[0-9a-f]{40}$" },
                limit: { type: "integer", minimum: 1, maximum: 100 },
              },
            },
            returned: { type: "integer", minimum: 0, maximum: 100 },
            hasMore: { type: "boolean" },
            items: { type: "array", maxItems: 100, items: { $ref: "#/components/schemas/DeadLetterDiagnostic" } },
          },
        },
        lastRun: { anyOf: [{ $ref: "#/components/schemas/IndexerScanRun" }, { type: "null" }] },
      },
    },
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
    "/api/dacs/status": {
      get: {
        summary: "Catalog freshness and bounded indexer diagnostics",
        parameters: [
          { name: "deadLetterLimit", in: "query", description: "Maximum recent active dead-letter diagnostics to return.", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
          { name: "locator", in: "query", description: "Return diagnostics for one exact lowercase storage locator.", schema: { type: "string", pattern: "^stor-[0-9a-f]{40}$" } },
        ],
        responses: {
          "200": { description: "Indexer, chain-tip, and public-safe dead-letter state", content: { "application/json": { schema: { $ref: "#/components/schemas/CatalogStatus" } } } },
          "400": { description: "Invalid diagnostics query" },
        },
      },
    },
  },
  components: { schemas: {
    ListingSummary: listingSummarySchema,
    DeadLetterDiagnostic: deadLetterDiagnosticSchema,
    IndexerScanRun: indexerScanRunSchema,
    CatalogStatus: catalogStatusSchema,
  } },
});
