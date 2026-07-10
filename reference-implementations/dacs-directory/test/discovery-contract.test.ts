import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { directoryManifest, listingSummarySchema, openApiDocument } from "../src/catalog/contracts.js";
import { catalogJson } from "../src/catalog/http.js";

test("directory manifest lets an agent discover every contract from the origin", () => {
  const origin = "https://directory.example";
  const manifest = directoryManifest(origin);
  assert.equal(manifest.humanUrl, origin);
  assert.equal(manifest.agentCard, `${origin}/.well-known/agent.json`);
  assert.equal(manifest.catalog, `${origin}/api/dacs/listings`);
  assert.equal(manifest.openapi, `${origin}/openapi.json`);
  assert.equal(manifest.schemas.listingSummary, `${origin}/schemas/listing-summary.schema.json`);
  assert.ok(manifest.filters.includes("identityTier"));
});

test("OpenAPI and JSON Schema describe the listing discovery surface", () => {
  const document = openApiDocument("https://directory.example");
  assert.equal(document.openapi, "3.1.0");
  assert.ok(document.paths["/api/dacs/listings"]);
  assert.ok(document.paths["/api/dacs/listings/{listingId}/{version}"]);
  assert.ok(listingSummarySchema.required.includes("contentHash"));
  assert.ok(listingSummarySchema.required.includes("offering"));
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
