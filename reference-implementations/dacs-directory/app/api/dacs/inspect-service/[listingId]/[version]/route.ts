/** GET /api/dacs/inspect-service/{listingId}/{version} — verifier-ready Directory profile envelope. */
import { NextRequest, NextResponse } from "next/server";
import { MAX_CLAIM_QUERY_BYTES, sellerIdentity } from "@/src/catalog/discovery";
import { catalogJson } from "@/src/catalog/http";
import {
  buildDirectoryServiceInspectionEnvelope,
  listingJsonPath,
  servicePath,
} from "@/src/catalog/inspection";
import { requestBaseUrl } from "@/src/catalog/publicUrl";
import { loadCatalog } from "@/src/catalog/store";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ listingId: string; version: string }> },
) {
  const { listingId, version } = await params;
  const requestedSeller = req.nextUrl.searchParams.get("seller")?.trim();
  if (requestedSeller && Buffer.byteLength(requestedSeller, "utf8") > MAX_CLAIM_QUERY_BYTES) {
    return NextResponse.json({ error: "seller exceeds 1024 bytes" }, { status: 400 });
  }
  if (!requestedSeller) {
    return NextResponse.json({ error: "seller is required" }, { status: 400 });
  }
  const requestedIdentity = requestedSeller ? sellerIdentity(requestedSeller) : undefined;
  const hit = loadCatalog().sellers
    .filter((seller) => !requestedIdentity || seller.primaryClaim === requestedIdentity)
    .flatMap((seller) => seller.listings)
    .find((listing) => listing.listingId === listingId && String(listing.version) === version);
  if (!hit) return NextResponse.json({ error: "listing not found" }, { status: 404 });

  const origin = requestBaseUrl(req);
  const envelope = buildDirectoryServiceInspectionEnvelope(origin, hit);
  return catalogJson(req, envelope, {
    lastModified: hit.catalogObservedAt,
    links: [
      { href: envelope.source.url, rel: "self", type: "application/json" },
      { href: `${origin}${listingJsonPath(hit)}`, rel: "item", type: "application/json" },
      { href: `${origin}${servicePath(hit)}`, rel: "alternate", type: "text/html" },
    ],
  });
}
