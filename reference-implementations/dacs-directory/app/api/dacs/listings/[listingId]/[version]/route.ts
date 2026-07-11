/** GET /api/dacs/listings/{listingId}/{version} — §6.3.6: the listing summary + anchor. */
import { NextRequest, NextResponse } from "next/server";
import { loadCatalog } from "@/src/catalog/store";
import { readAnchor } from "@/src/catalog/chain";
import { verifyListing } from "@/src/catalog/listingVerification";
import { catalogJson } from "@/src/catalog/http";
import { requestBaseUrl } from "@/src/catalog/publicUrl";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ listingId: string; version: string }> },
) {
  const { listingId, version } = await params;
  const requestedSeller = req.nextUrl.searchParams.get("seller");
  const origin = requestBaseUrl(req);
  const hit = loadCatalog()
    .sellers.flatMap((s) => s.listings)
    .find((l) => l.listingId === listingId && String(l.version) === version && (!requestedSeller || l.seller.primaryClaim === requestedSeller));
  if (!hit) return NextResponse.json({ error: "listing not found" }, { status: 404 });
  const raw = await readAnchor(hit.anchor.locator);
  const verified = raw ? await verifyListing(raw) : null;
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
      { href: `${origin}/service/${encodeURIComponent(hit.seller.primaryClaim)}/${encodeURIComponent(hit.listingId)}/${hit.version}`, rel: "alternate", type: "text/html" },
      { href: `${origin}/api/dacs/sellers/${encodeURIComponent(hit.seller.primaryClaim)}`, rel: "seller", type: "application/json" },
      { href: `${origin}/schemas/listing-summary.schema.json`, rel: "describedby", type: "application/schema+json" },
    ],
  });
}
