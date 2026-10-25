/** GET /api/dacs/listings/{listingId}/{version} — §6.3.6: the listing summary + anchor. */
import { NextRequest, NextResponse } from "next/server";
import { loadCatalog } from "@/src/catalog/store";
import { readAnchorResult } from "@/src/catalog/chain";
import {
  readCounterpartyEvidenceFixtureAnchor,
  verifyCounterpartyEvidenceFixtureListing,
} from "@/src/catalog/counterpartyEvidence";
import { MAX_CLAIM_QUERY_BYTES, sellerIdentity } from "@/src/catalog/discovery";
import { verifyStoredListing } from "@/src/catalog/listingVerification";
import { catalogJson } from "@/src/catalog/http";
import { inspectServicePath, servicePath } from "@/src/catalog/inspection";
import { requestBaseUrl } from "@/src/catalog/publicUrl";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ listingId: string; version: string }> },
) {
  const { listingId, version } = await params;
  const requestedSeller = req.nextUrl.searchParams.get("seller");
  if (requestedSeller && Buffer.byteLength(requestedSeller, "utf8") > MAX_CLAIM_QUERY_BYTES) {
    return NextResponse.json({ error: "seller exceeds 1024 bytes" }, { status: 400 });
  }
  const origin = requestBaseUrl(req);
  const requestedIdentity = requestedSeller ? sellerIdentity(requestedSeller) : undefined;
  const hit = loadCatalog().sellers
    .filter((seller) => !requestedIdentity || seller.primaryClaim === requestedIdentity)
    .flatMap((seller) => seller.listings)
    .find((listing) => listing.listingId === listingId && String(listing.version) === version);
  if (!hit) return NextResponse.json({ error: "listing not found" }, { status: 404 });
  if (hit.anchor.kind === "fixture") {
    const fixture = readCounterpartyEvidenceFixtureAnchor(hit.anchor.locator);
    if (!fixture || !verifyCounterpartyEvidenceFixtureListing(fixture, hit)) {
      return NextResponse.json({ error: "fixture listing failed verification" }, { status: 502 });
    }
    return catalogJson(req, fixture, {
      lastModified: hit.catalogObservedAt,
      links: [
        { href: `${origin}${servicePath(hit)}`, rel: "alternate", type: "text/html" },
        { href: `${origin}/api/dacs/sellers/${encodeURIComponent(sellerIdentity(hit.seller.primaryClaim))}`, rel: "seller", type: "application/json" },
        { href: `${origin}/schemas/listing-summary.schema.json`, rel: "describedby", type: "application/schema+json" },
      ],
    });
  }
  const read = await readAnchorResult(hit.anchor.locator);
  if (read.status === "unavailable") {
    return NextResponse.json({ error: "listing anchor unavailable: the Demos node could not be read" }, { status: 503 });
  }
  const raw = read.status === "present" ? read.record.data : null;
  const verified = raw ? await verifyStoredListing(raw, hit.anchor.locator) : null;
  if (!verified || verified.contentHash !== hit.contentHash) {
    return NextResponse.json({ error: "listing anchor failed verification" }, { status: 502 });
  }
  const actualId = typeof verified.scope.listingId === "string"
    ? verified.scope.listingId
    : verified.scope.serviceId;
  const actualVersion = verified.scope.listingVersion ?? verified.scope.version ?? 1;
  if (actualId !== listingId || String(actualVersion) !== version) {
    return NextResponse.json({ error: "listing anchor does not match requested id/version" }, { status: 502 });
  }
  return catalogJson(req, raw, {
    lastModified: hit.catalogObservedAt,
    links: [
      { href: `${origin}${servicePath(hit)}`, rel: "alternate", type: "text/html" },
      { href: `${origin}/api/dacs/sellers/${encodeURIComponent(sellerIdentity(hit.seller.primaryClaim))}`, rel: "seller", type: "application/json" },
      { href: `${origin}${inspectServicePath(hit)}`, rel: "service-inspection", type: "application/json" },
      { href: `${origin}/schemas/listing-summary.schema.json`, rel: "describedby", type: "application/schema+json" },
    ],
  });
}
