import assert from "node:assert/strict";
import test from "node:test";
import { directoryManifest, listingSummarySchema, openApiDocument } from "../src/catalog/contracts.js";

test("breaking ListingSummary contract has a versioned schema identity discoverable from the manifest", () => {
  assert.equal(listingSummarySchema.$id, "/schemas/listing-summary.v2.schema.json");
  assert.equal(directoryManifest("https://directory.example").schemas.listingSummary,
    `https://directory.example${listingSummarySchema.$id}`);
  assert.equal(openApiDocument("https://directory.example").components.schemas.ListingSummary.$id,
    listingSummarySchema.$id);
});

test("legacy schema URL redirects to the versioned schema without reflecting request input", async () => {
  const { GET } = await import("../app/schemas/listing-summary.schema.json/route.js");
  const response = await GET();
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), listingSummarySchema.$id);
  assert.equal(await response.text(), "");
  assert.match(response.headers.get("cache-control") ?? "", /must-revalidate/);
});

test("versioned schema serves its identity and revalidates an exact ETag", async () => {
  const { NextRequest } = await import("next/server");
  const { GET } = await import("../app/schemas/listing-summary.v2.schema.json/route.js");
  const url = `https://directory.example${listingSummarySchema.$id}`;
  const response = await GET(new NextRequest(url));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), JSON.parse(JSON.stringify(listingSummarySchema)));
  const etag = response.headers.get("etag");
  assert.ok(etag);
  const unchanged = await GET(new NextRequest(url, { headers: { "if-none-match": etag } }));
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), "");
  const changed = await GET(new NextRequest(url, { headers: { "if-none-match": '"different"' } }));
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).$id, listingSummarySchema.$id);
});

test("public discovery sources advertise the versioned schema directly", async () => {
  const { readFileSync } = await import("node:fs");
  const paths = [
    "app/api/dacs/route.ts",
    "app/api/dacs/listings/route.ts",
    "app/api/dacs/listings/[listingId]/[version]/route.ts",
    "app/api/dacs/sellers/[primaryClaimRef]/route.ts",
    "app/llms.txt/route.ts",
  ];
  for (const path of paths) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.ok(source.includes(listingSummarySchema.$id), path);
    assert.ok(!source.includes("/schemas/listing-summary.schema.json"), path);
  }
});
