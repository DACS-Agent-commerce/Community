import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { activeCatalogListings } from "../src/catalog/discovery.js";
import { indexRegistration } from "../src/catalog/indexer.js";
import type { Catalog, Registration } from "../src/catalog/types.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(process.cwd(), "test", "fixtures", name), "utf8")) as unknown;

test("shipped ReviewBot seed produces a visible active listing from pinned chain bytes", async () => {
  const registrations = JSON.parse(
    readFileSync(join(process.cwd(), "data", "registrations.example.json"), "utf8"),
  ) as Registration[];
  const reviewBot = registrations.find((reg) => reg.displayName === "ReviewBot");
  assert.ok(reviewBot, "registrations.example.json should include the ReviewBot seed");

  const listingAnchor = "stor-9f990919614234174e89241dc221f31fb516acbe";
  assert.ok(reviewBot.listingAnchors.includes(listingAnchor), "ReviewBot should point at the pinned listing anchor");

  const originalFetch = globalThis.fetch;
  const seen = new Set<string>();
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.add(url);
    if (url.endsWith(`/storage-program/${listingAnchor}`)) {
      return new Response(JSON.stringify(fixture("reviewbot-listing-anchor.json")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ success: false }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const seller = await indexRegistration(
      reviewBot,
      undefined,
      async () => {
        throw new Error("identity unavailable in fixture smoke");
      },
    );
    const catalog: Catalog = { catalogVersion: "1", generatedAt: 1, sellers: [seller] };
    const listings = activeCatalogListings(catalog);

    assert.equal(listings.length, 1);
    assert.equal(listings[0].seller.primaryClaim, reviewBot.primaryClaim);
    assert.equal(listings[0].listingId, "pr-review");
    assert.equal(listings[0].status, "active");
    assert.deepEqual(listings[0].offering.rails, ["pay-dem", "pay-x402"]);
    assert.ok(
      listings[0].offering.title.includes("LLM code review"),
      "the seed should render the real ReviewBot offer",
    );
    assert.ok(
      !listings[0].offering.description?.includes("[github:"),
      "catalog presentation should strip the interim identity carrier tag",
    );
    assert.ok([...seen].every((url) => url.includes("/storage-program/")), "smoke must not call live scan or GCR");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
