import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

import type { ListingSummary, SellerRecord } from "../src/catalog/types.js";

// Transaction readiness: only the SDK's ordered Listing reader grants it, so
// every published catalog projection carries the Directory's own disposition.
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-listing-admission-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
const store = await import("../src/catalog/store.js");
const { DIRECTORY_TRANSACTION_READINESS, buildDirectoryServiceProfile } = await import("../src/catalog/inspection.js");
const { GET: listingsGet } = await import("../app/api/dacs/listings/route.js");
const { GET: sellerGet } = await import("../app/api/dacs/sellers/[primaryClaimRef]/route.js");

test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));

const seller = `did:demos:agent:${"29".repeat(32)}`;

test("published summaries never claim transaction readiness the Directory did not assess", async () => {
  const summary = (listingId: string, transactionReadiness?: unknown): ListingSummary => ({
    listingId,
    version: 1,
    contentHash: "c".repeat(64),
    anchor: { kind: "storage-program", locator: `stor-${"4".repeat(40)}` },
    seller: { primaryClaim: seller, displayName: "Admission Desk" },
    offering: { title: listingId, category: "services.test", tags: [] },
    pricing: {},
    status: "active",
    catalogObservedAt: 1,
    ...(transactionReadiness === undefined ? {} : { transactionReadiness }),
  } as ListingSummary);
  const forged = summary("forged-ready", { disposition: "ready", reason: "stored by an older or hostile writer" });
  const record: SellerRecord = {
    primaryClaim: seller,
    displayName: "Admission Desk",
    cci: [],
    listings: [forged, summary("readiness-absent")],
    deals: [],
    reputation: { completed: 0, bundleCount: 0, totalAgreements: 0, completionRate: null },
    registeredAt: 1,
    lastIndexedAt: 1,
  } as SellerRecord;
  store.saveCatalog({ catalogVersion: "1", generatedAt: 2, sellers: [record] });

  const catalog = await (await listingsGet(new NextRequest("https://directory.example/api/dacs/listings"))).json();
  const sellerView = await (await sellerGet(
    new NextRequest(`https://directory.example/api/dacs/sellers/${encodeURIComponent(seller)}`),
    { params: Promise.resolve({ primaryClaimRef: seller }) },
  )).json();
  for (const published of [...catalog.listings, ...sellerView.listings]) {
    assert.deepEqual(published.transactionReadiness, DIRECTORY_TRANSACTION_READINESS, published.listingId);
  }
  assert.equal(catalog.listings.length, 2);
  assert.equal(sellerView.listings.length, 2);
  assert.deepEqual(
    buildDirectoryServiceProfile("https://directory.example", forged).transactionReadiness,
    DIRECTORY_TRANSACTION_READINESS,
  );
});
