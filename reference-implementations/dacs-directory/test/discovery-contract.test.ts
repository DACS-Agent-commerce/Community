import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NextRequest } from "next/server";

import {
  catalogStatusSchema,
  deadLetterDiagnosticSchema,
  directoryManifest,
  indexerScanRunSchema,
  listingRejectionDiagnosticSchema,
  listingSummarySchema,
  openApiDocument,
} from "../src/catalog/contracts.js";
import { catalogJson } from "../src/catalog/http.js";
import { requestBaseUrl } from "../src/catalog/publicUrl.js";
import { safeJsonLd } from "../src/components/structuredData.js";
import { parsePagination } from "../src/catalog/pagination.js";
import { primaryClaimMatches } from "../src/catalog/discovery.js";
import { publicDemosRpcUrl } from "../src/catalog/substrateDiscovery.js";

test("public navigation never sends visitors to the private SDK repository", () => {
  const files = [
    new URL("../app/layout.tsx", import.meta.url),
    new URL("../app/how-it-works/page.tsx", import.meta.url),
  ];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /github\.com\/DACS-Agent-commerce\/dacs-sdk/);
    assert.match(source, /DACS-Standard\/blob\/main\/docs\/builders-guide\.md/);
  }
});

test("directory manifest lets an agent discover every contract from the origin", () => {
  const origin = "https://directory.example";
  const rpc = "https://node.example/demos";
  const manifest = directoryManifest(origin, rpc);
  assert.equal(manifest.humanUrl, origin);
  assert.equal(manifest.agentCard, `${origin}/.well-known/agent.json`);
  assert.equal(manifest.catalog, `${origin}/api/dacs/listings`);
  assert.equal(manifest.bundleBindings, `${origin}/api/dacs/bundles/{jobId}`);
  assert.equal(manifest.inspectService, `${origin}/api/dacs/inspect-service/{listingId}/{version}?seller={primaryClaim}`);
  assert.equal(manifest.openapi, `${origin}/openapi.json`);
  assert.equal(manifest.schemas.listingSummary, `${origin}/schemas/listing-summary.schema.json`);
  assert.equal(manifest.substrates.demos.rpcUrl, rpc);
  assert.equal(
    manifest.substrates.demos.anchors["storage-program"].read.urlTemplate,
    `${rpc}/storage-program/{locator}`,
  );
  assert.equal(manifest.substrates.demos.anchors["storage-program"].read.authentication, "none");
  assert.equal(manifest.substrates.demos.anchors["storage-program"].read.responseDataPointer, "/data");
  assert.equal(manifest.substrates.demos.anchors["storage-program"].read.responseOwnerPointer, "/owner");
  assert.ok(manifest.filters.includes("identityTier"));
});

test("public substrate discovery never leaks the indexer's private RPC setting", () => {
  const priorInternal = process.env.DEMOS_RPC;
  const priorPublic = process.env.NEXT_PUBLIC_DEMOS_RPC;
  process.env.DEMOS_RPC = "http://10.0.0.8:9944/private";
  delete process.env.NEXT_PUBLIC_DEMOS_RPC;
  try {
    assert.equal(publicDemosRpcUrl(), "https://demosnode.discus.sh");
    assert.equal(publicDemosRpcUrl("https://public.example/rpc///"), "https://public.example/rpc");
    assert.throws(() => publicDemosRpcUrl("http://public.example"), /credential-free HTTPS origin/);
    assert.throws(() => publicDemosRpcUrl("https://user:secret@public.example"), /credential-free HTTPS origin/);
    assert.throws(() => publicDemosRpcUrl("https://public.example?token=secret"), /credential-free HTTPS origin/);
  } finally {
    if (priorInternal === undefined) delete process.env.DEMOS_RPC;
    else process.env.DEMOS_RPC = priorInternal;
    if (priorPublic === undefined) delete process.env.NEXT_PUBLIC_DEMOS_RPC;
    else process.env.NEXT_PUBLIC_DEMOS_RPC = priorPublic;
  }
});

test("OpenAPI and JSON Schema describe the listing discovery surface", () => {
  const document = openApiDocument("https://directory.example");
  assert.equal(document.openapi, "3.1.0");
  assert.ok(document.paths["/api/dacs/listings"]);
  assert.ok(document.paths["/api/dacs/listings/{listingId}/{version}"]);
  assert.ok(document.paths["/api/dacs/bundles/{jobId}"]);
  assert.ok(document.paths["/api/dacs/inspect-service/{listingId}/{version}"]);
  const inspectSeller = document.paths["/api/dacs/inspect-service/{listingId}/{version}"].get.parameters
    .find((parameter) => parameter.name === "seller");
  assert.equal(inspectSeller?.required, true);
  assert.equal(inspectSeller?.schema.minLength, 1);
  assert.equal(inspectSeller?.schema.pattern, "\\S");
  assert.ok(listingSummarySchema.required.includes("contentHash"));
  assert.ok(listingSummarySchema.required.includes("offering"));
  assert.equal(listingSummarySchema.properties.inspection.properties.artifactType.const, "directory-service-profile");
  assert.ok(listingSummarySchema.properties.inspection.properties.maturity.enum.includes("listed"));
  assert.equal(listingSummarySchema.properties.inspection.properties.href.format, "uri-reference");
  assert.ok(listingSummarySchema.properties.artifactProfile.enum.includes("fixture-listing"));
  assert.ok(listingSummarySchema.properties.pricing.properties.kind.enum.includes("metered"));
  assert.equal(listingSummarySchema.properties.pricing.properties.minTotalHint.type, "string");
  assert.ok(listingSummarySchema.allOf[0].then.required.includes("revocation"));
  assert.equal(
    listingSummarySchema.properties.revocation.properties.markerContentHash.pattern,
    "^[0-9a-f]{64}$",
  );
  const filters = document.paths["/api/dacs/listings"].get.parameters.map((parameter) => parameter.name);
  assert.ok(filters.includes("identityTier"));
  const profile = document.paths["/api/dacs/listings"].get.parameters.find((parameter) => parameter.name === "profile");
  assert.ok(profile?.schema.enum);
  assert.ok(profile.schema.enum.includes("fixture-listing"));
  for (const filter of ["credential", "primaryClaim", "priceMax", "minCompletionRate", "minRating"]) {
    assert.ok(filters.includes(filter), `missing normative filter ${filter}`);
  }
  const status = document.paths["/api/dacs/status"].get;
  assert.deepEqual(status.parameters.map((parameter) => parameter.name), ["deadLetterLimit", "locator"]);
  assert.equal(status.parameters[0].schema.maximum, 100);
  assert.equal(status.responses["200"].content["application/json"].schema.$ref, "#/components/schemas/CatalogStatus");
  assert.ok(catalogStatusSchema.properties.indexer.properties.deadLetterDiagnostics);
  assert.ok(catalogStatusSchema.properties.indexer.properties.listingRejectionDiagnostics);
  assert.ok(catalogStatusSchema.required.includes("cursorAheadBy"));
  assert.ok(catalogStatusSchema.required.includes("chainResetSuspected"));
  assert.ok(catalogStatusSchema.required.includes("secondsSinceCursorAdvanced"));
  assert.ok(catalogStatusSchema.required.includes("cursorStalled"));
  assert.equal(deadLetterDiagnosticSchema.properties.retryState.const, "exhausted");
  assert.deepEqual([...listingRejectionDiagnosticSchema.properties.code.enum], [
    "SELLER_CLAIM_BINDING",
    "OWNER_CLAIM_BINDING",
    "NORMATIVE_LISTING_INVALID",
    "VERIFICATION_METHOD_INVALID",
    "LISTING_SIGNATURE_INVALID",
    "IDENTITY_PRESENTATION_INVALID",
    "LEGACY_LISTING_INVALID",
    "DECLARED_CONTENT_HASH_MISMATCH",
  ]);
  assert.equal(indexerScanRunSchema.additionalProperties, false);
  assert.ok(!("error" in indexerScanRunSchema.properties));
});

test("catalog responses expose cache validators and honor conditional reads", async () => {
  const first = catalogJson(new NextRequest("https://directory.example/api/dacs"), { ok: true }, {
    links: [{ href: "https://directory.example/openapi.json", rel: "service-desc", type: "application/json" }],
  });
  assert.equal(first.status, 200);
  assert.match(first.headers.get("cache-control") ?? "", /stale-while-revalidate/);
  assert.match(first.headers.get("link") ?? "", /service-desc/);
  const etag = first.headers.get("etag");
  assert.ok(etag);

  const conditional = catalogJson(new NextRequest("https://directory.example/api/dacs", {
    headers: { "if-none-match": etag! },
  }), { ok: true });
  assert.equal(conditional.status, 304);
  assert.equal(await conditional.text(), "");
});

test("public links never expose an internal proxy origin", () => {
  const prior = process.env.NEXT_PUBLIC_DIRECTORY_URL;
  process.env.NEXT_PUBLIC_DIRECTORY_URL = "https://directory.example/";
  try {
    const request = new NextRequest("http://localhost:8080/api/dacs", {
      headers: { "x-forwarded-host": "proxy.example", "x-forwarded-proto": "https" },
    });
    assert.equal(requestBaseUrl(request), "https://directory.example");
  } finally {
    if (prior === undefined) delete process.env.NEXT_PUBLIC_DIRECTORY_URL;
    else process.env.NEXT_PUBLIC_DIRECTORY_URL = prior;
  }
});

test("JSON-LD serialization cannot break out of its script element", () => {
  const hostile = { name: "</script><img src=x onerror=alert(1)>", nested: ["<!--", "<script>"] };
  const out = safeJsonLd(hostile);
  assert.ok(!out.includes("<"));
  // Escaping must not change the data consumers parse.
  assert.deepEqual(JSON.parse(out), hostile);
});

test("OpenAPI advertises the same limit bounds the API enforces", () => {
  const document = openApiDocument("https://directory.example");
  const limit = document.paths["/api/dacs/listings"].get.parameters
    .find((parameter) => parameter.name === "limit");
  const maximum = limit?.schema.maximum;
  assert.ok(typeof maximum === "number");
  assert.equal(parsePagination(String(maximum), null).ok, true);
  assert.equal(parsePagination(String(maximum + 1), null).ok, false);
});

test("primaryClaim filtering accepts exact claims and canonical prefixes", () => {
  const claim = `did:demos:agent:${"a".repeat(64)}`;
  assert.equal(primaryClaimMatches(claim, claim), true);
  assert.equal(primaryClaimMatches(claim, "did:demos:agent"), true);
  assert.equal(primaryClaimMatches(claim, "did:demos:other"), false);
  assert.equal(primaryClaimMatches(claim, `${claim}:extra`), false);
});
