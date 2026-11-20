/** GET /api/dacs/listings/{listingId}/{version} — §6.3.6: the listing summary + anchor. */
import { NextRequest, NextResponse } from "next/server";
import { loadCatalog, lookupArchivedListingVersion } from "@/src/catalog/store";
import { readAnchorResult } from "@/src/catalog/chain";
import {
  readCounterpartyEvidenceFixtureAnchor,
  verifyCounterpartyEvidenceFixtureListing,
} from "@/src/catalog/counterpartyEvidence";
import { verifyStoredListing } from "@/src/catalog/listingVerification";
import { sellerIdentity } from "@/src/catalog/discovery";
import { catalogJson, claimQuery } from "@/src/catalog/http";
import { inspectServicePath, servicePath } from "@/src/catalog/inspection";
import { requestBaseUrl } from "@/src/catalog/publicUrl";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ listingId: string; version: string }> },
) {
  const { listingId, version } = await params;
  const sellerQuery = claimQuery(req.nextUrl.searchParams.get("seller"), "seller");
  if ("refused" in sellerQuery) return sellerQuery.refused;
  const requestedSeller = sellerQuery.value;
  const origin = requestBaseUrl(req);
  const catalog = loadCatalog();
  const current = catalog
    .sellers.flatMap((s) => s.listings)
    .find((l) => l.listingId === listingId && String(l.version) === version && (!requestedSeller || sellerIdentity(l.seller.primaryClaim) === sellerIdentity(requestedSeller)));
  const archived = current ? null : lookupArchivedListingVersion({ listingId, version, seller: requestedSeller ?? undefined });
  if (archived?.kind === "ambiguous") {
    return NextResponse.json({ error: "ambiguous listing version: more than one signed Listing is archived at this id and version" }, { status: 409 });
  }
  const hit = current ?? archived?.listing;
  if (!hit) return NextResponse.json({ error: "listing not found" }, { status: 404 });
  if (current?.anchor.kind === "fixture") {
    const fixture = readCounterpartyEvidenceFixtureAnchor(current.anchor.locator);
    if (!fixture || !verifyCounterpartyEvidenceFixtureListing(fixture, current)) {
      return NextResponse.json({ error: "fixture listing failed verification" }, { status: 502 });
    }
    return catalogJson(req, fixture, {
      lastModified: current.catalogObservedAt,
      links: [
        { href: `${origin}${servicePath(current)}`, rel: "alternate", type: "text/html" },
        { href: `${origin}/api/dacs/sellers/${encodeURIComponent(sellerIdentity(current.seller.primaryClaim))}`, rel: "seller", type: "application/json" },
        { href: `${origin}/schemas/listing-summary.v2.schema.json`, rel: "describedby", type: "application/schema+json" },
      ],
    });
  }
  const read = await readAnchorResult(hit.anchor.locator);
  if (read.status === "unavailable" || read.status === "absent") {
    const reason = read.status === "unavailable" ? read.reason : "anchor not found";
    const error = read.status === "absent"
      ? "listing anchor unavailable: the node reports no storage program at the anchor"
      : "listing anchor unavailable: the Demos node could not be read";
    return NextResponse.json({ error, reason }, { status: 503 });
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
  // A version outside the current catalog has no service page or inspection envelope, and its seller
  // may have left the catalog: advertise only targets that resolve now.
  const sellerRef = sellerIdentity(hit.seller.primaryClaim);
  const sellerListed = Boolean(current) || catalog.sellers.some((s) => s.primaryClaim === sellerRef);
  return catalogJson(req, raw, {
    lastModified: hit.catalogObservedAt,
    links: [
      ...(current ? [{ href: `${origin}${servicePath(current)}`, rel: "alternate", type: "text/html" }] : []),
      ...(sellerListed ? [{ href: `${origin}/api/dacs/sellers/${encodeURIComponent(sellerRef)}`, rel: "seller", type: "application/json" }] : []),
      ...(current ? [{ href: `${origin}${inspectServicePath(current)}`, rel: "service-inspection", type: "application/json" }] : []),
      { href: `${origin}/schemas/listing-summary.v2.schema.json`, rel: "describedby", type: "application/schema+json" },
    ],
  });
}
