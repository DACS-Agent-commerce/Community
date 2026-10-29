import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
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
import { activeOffer, activeCatalogListings, activeCatalogSellers, discoveryListing, primaryClaimMatches } from "../src/catalog/discovery.js";
import { publicDemosRpcUrl } from "../src/catalog/substrateDiscovery.js";

test("public navigation never sends visitors to the private SDK repository", () => {
  const files = [
    new URL("../app/layout.tsx", import.meta.url),
    new URL("../app/how-it-works/page.tsx", import.meta.url),
  ];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /github\.com\/DACS-Agent-commerce\/dacs-sdk/);
    // Normative links name the Standard revision the pinned SDK declares, never mutable main.
    assert.match(source, /DACS-Standard\/blob\/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20\/docs\/builders-guide\.md/);
    assert.match(source, /DACS-Standard\/tree\/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20"/);
    assert.doesNotMatch(source, /DACS-Standard\/(?:blob|tree)\/main/);
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

test("the TP-1 contract change carries version signals and the exact advertised filters", async () => {
  const manifest = directoryManifest("https://directory.example", "https://node.example/demos");
  assert.equal(manifest.dacsDirectoryVersion, "2");
  assert.deepEqual([...manifest.restrictions], ["TP-1"]);
  assert.match(manifest.maturity.reputation, /^Completion verification unavailable\./);
  assert.match(manifest.maturity.reputation, /Testnet publishes observed counts and individual evidence/);
  assert.match(manifest.maturity.reputation, /completion and fault rates and numeric reputation scores are null/);
  assert.deepEqual(manifest.filters, [
    "category", "tag", "credential", "primaryClaim", "identityTier", "rail", "priceMax", "q", "profile", "limit", "cursor",
  ]);
  const document = openApiDocument("https://directory.example");
  assert.equal(document.info.version, "2.0.0");
  const listings = document.paths["/api/dacs/listings"].get;
  assert.deepEqual(listings.parameters.map((parameter) => parameter.name).sort(), [...manifest.filters].sort());
  assert.deepEqual(listings.responses, {
    "200": { description: "A cursor-paginated listing page" },
    "400": { description: "Invalid query, an unlisted query name, unavailable rate/score filtering or ranking, or primaryClaim over 1024 bytes" },
  });
  assert.match(listings.description, /Completion verification unavailable.*minCompletionRate and minRating.*400/);
  assert.match(listings.description, /every query name not listed here are refused with 400/);
  // The API index reports the same contract version as the manifest.
  const { GET: getIndex } = await import("../app/api/dacs/route.js");
  assert.equal((await (await getIndex(new NextRequest("https://directory.example/api/dacs"))).json()).version, "2");
  // The schema URL is unversioned, so a changed schema must not be cached as immutable.
  const { GET: getSchema } = await import("../app/schemas/listing-summary.schema.json/route.js");
  const response = await getSchema(new NextRequest("https://directory.example/schemas/listing-summary.schema.json"));
  const cacheControl = response.headers.get("cache-control") ?? "";
  assert.doesNotMatch(cacheControl, /immutable/);
  assert.match(cacheControl, /must-revalidate/);
  assert.ok(Number(/max-age=(\d+)/.exec(cacheControl)?.[1]) <= 300, cacheControl);
  assert.deepEqual(await response.json(), JSON.parse(JSON.stringify(listingSummarySchema)));
});

test("TP-1 is defined in-tree and declares its deviations in the Standard's ImplementationDeviation shape", () => {
  const definition = readFileSync(new URL("../docs/TP-1.md", import.meta.url), "utf8");
  const sourcePin = readFileSync(new URL("../SPEC_PIN", import.meta.url), "utf8").match(/^[a-f0-9]{40}$/m)?.[0];
  assert.ok(sourcePin, "SPEC_PIN must declare the Standard source revision");
  assert.ok(definition.includes(`DACS-Standard/tree/${sourcePin}`), "TP-1 must describe the retained Standard source revision");
  const block = /```json\n([\s\S]+?)\n```/.exec(definition);
  assert.ok(block, "TP-1 must carry its deviation JSON block");
  const deviations: unknown = JSON.parse(block[1]);
  assert.ok(Array.isArray(deviations), "deviations must be an array");
  assert.ok(deviations.length > 0, "TP-1 must declare its nonconformance");
  // Exact fixture from DACS-Standard 4bb9e48a, conformance/implementation-manifest.schema.json.
  const schemaBytes = readFileSync(new URL("./fixtures/dacs-standard/implementation-manifest.schema.json", import.meta.url));
  assert.equal(createHash("sha256").update(schemaBytes).digest("hex"), "e6dfc82a621737c2a422aa0708e10776f832608255f5bdc77acacbd77aabf805");
  const standard: { $schema: string; $defs: Record<string, unknown> } = JSON.parse(schemaBytes.toString("utf8"));
  const validate = new Ajv2020().compile<Record<string, unknown>>({
    $schema: standard.$schema, $defs: standard.$defs, $ref: "#/$defs/deviation",
  });
  let required: Record<string, unknown> | undefined;
  const entries: unknown[] = deviations;
  for (const deviation of entries) {
    assert.ok(validate(deviation), JSON.stringify(validate.errors));
    assert.deepEqual(Object.keys(deviation).sort(), ["capabilityRefs", "description", "effect", "id", "ruleRefs", "status"]);
    assert.equal(deviation.status, "open");
    assert.equal(deviation.effect, "nonconforming");
    if (deviation.id === "tp-1-null-rates-and-refused-rate-filters") required = deviation;
  }
  assert.ok(required, "TP-1 must retain its null-rate and refused-filter deviation");
  assert.deepEqual(required.capabilityRefs, ["directory-catalog-api", "directory-reputation-hints"]);
  assert.deepEqual(required.ruleRefs, ["DACS-1-6.3.6", "DACS-5-10.5.3", "DACS-5-10.5.4"]);
  assert.doesNotMatch(definition, /pinned SDK catalog reader/);
  assert.equal(typeof required.description, "string");
  assert.match(required.description as string, /minCompletionRate and minRating return 400 instead of filtering/);
  assert.match(required.description as string, /completionRate and averageSellerRating are null even when bundleCount is positive/);
  assert.doesNotMatch(required.description as string, /\bconform/i);
  // Rule 2 lists exactly the manifest's filters.
  const filterList = /^2\. The listings API accepts only the documented listing filters:([\s\S]+?) \(the manifest's/m.exec(definition);
  assert.ok(filterList, "TP-1 Rule 2 must declare the listing filters");
  const documentedFilters = [...filterList[1].matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  assert.deepEqual(documentedFilters, directoryManifest("https://directory.example").filters);
  assert.match(readFileSync(new URL("../README.md", import.meta.url), "utf8"), /\(\.\/docs\/TP-1\.md\)/);
  assert.doesNotMatch(readFileSync(new URL("../src/catalog/testnetMetrics.ts", import.meta.url), "utf8"), /DEC-11/);
});

test("README and agent text say rates and ratings are null, other scores are omitted, and hints follow the Directory schema", async () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.doesNotMatch(readme, /pinned SDK (?:catalog )?reader/);
  assert.doesNotMatch(readme, /reputation scores as `null`/);
  assert.match(readme, /average buyer and seller ratings as `null`, with a reason, and omit any\s+other score field/);
  const { GET: getLlms } = await import("../app/llms.txt/route.js");
  const llms = await (await getLlms()).text();
  assert.doesNotMatch(llms, /reputation scores are null/);
  assert.match(llms, /average ratings are null on testnet under TP-1, and other score fields are omitted/);
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
  assert.ok(listingSummarySchema.required.includes("transactionReadiness"));
  assert.equal(listingSummarySchema.properties.transactionReadiness.additionalProperties, false);
  assert.equal(listingSummarySchema.properties.transactionReadiness.properties.disposition.const, "unassessed");
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
  for (const filter of ["credential", "primaryClaim", "priceMax"]) {
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
  assert.ok(listingRejectionDiagnosticSchema.properties.code.enum.includes("OWNER_CLAIM_BINDING"));
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


test("mixed current rails remain discoverable while alias-only offers are archival", () => {
  const listing = (rails: string[], status: "active" | "revoked" = "active") => ({
    artifactProfile: "dacs-v0.1", offering: { rails }, status,
  } as import("../src/catalog/types.js").ListingSummary);
  for (const [rails, expected] of [
    [["pay-dem"], false], [["pay-x402"], false], [["pay-dem", "pay-x402"], false],
    [["demos-native:DEM"], true], [["x402:default"], true],
    [["pay-dem", "demos-native:DEM"], true], [["x402:default", "pay-x402"], true],
    [[], true],
  ] as Array<[string[], boolean]>) {
    const offer = listing(rails);
    assert.equal(activeOffer(offer), expected, rails.join(","));
    assert.equal(discoveryListing(offer), expected);
    const seller = { listings: [offer] } as import("../src/catalog/types.js").SellerRecord;
    assert.equal(activeCatalogListings({ sellers: [seller] } as import("../src/catalog/types.js").Catalog).length, Number(expected));
    assert.equal(activeCatalogSellers([seller]).length, Number(expected));
    assert.equal(activeOffer(listing(rails, "revoked")), false);
  }
});

test("llms.txt requires the verified Listing disposition before a new session, not just before payment", async () => {
  const { GET } = await import("../app/llms.txt/route.js");
  const text = await (await GET()).text();
  assert.match(text, /verified disposition from the current SDK Listing reader before starting a new session \(DACS-1 LR-3\)/);
});
