import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { COMPLETION_VERIFICATION_UNAVAILABLE, LISTING_QUERY_PARAMETERS, UNAVAILABLE_TESTNET_METRICS } from "../src/catalog/testnetMetrics.js";
import { directoryManifest, listingSummarySchema, openApiDocument } from "../src/catalog/contracts.js";
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-testnet-no-rates-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
const { GET: getListings } = await import("../app/api/dacs/listings/route.js");
test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));

test("rate and score filters and ordering return a clear 400 even with empty, repeated or malformed values", async () => {
  for (const query of [
    "minCompletionRate=0.9", "minCompletionRate=0", "minCompletionRate=", "minCompletionRate=bad",
    "minCompletionRate=0.9&minCompletionRate=0.1", "minRating=5", "minRating=", "minRating=bad",
    "trackRecord=90", "maxFaultRate=0.1", "reputationScore=3", "sort=completionRate",
  ]) {
    const response = await getListings(new NextRequest(`https://directory.example/api/dacs/listings?${query}`));
    assert.equal(response.status, 400, query);
    const { error } = await response.json();
    assert.match(error, /unavailable on testnet/, query);
    assert.match(error, /TP-1/, query);
    assert.doesNotMatch(error, /minCompletionRate|MINCOMPLETIONRATE|sort=|order=|rank=/, query);
    if (/^(?:sort|order|rank)/i.test(query)) assert.equal(error, "Sorting and ranking are unavailable on testnet under TP-1.");
  }
});

test("the query allowlist is the manifest's filter list and the OpenAPI listing parameters", () => {
  assert.deepEqual([...directoryManifest("https://directory.example").filters], [...LISTING_QUERY_PARAMETERS]);
  const listing = openApiDocument("https://directory.example").paths["/api/dacs/listings"].get;
  assert.deepEqual(listing.parameters.map((parameter) => parameter.name), [
    "category", "tag", "rail", "credential", "primaryClaim", "identityTier", "priceMax", "q", "profile", "limit", "cursor",
  ]);
  assert.deepEqual(new Set(listing.parameters.map((parameter) => parameter.name)), new Set(LISTING_QUERY_PARAMETERS));
});
