/**
 * GET /api/dacs/sellers/{primaryClaimRef} — §6.3.6 seller view:
 * Listings, identity, observed history and unavailable testnet metrics.
 */
import { NextRequest, NextResponse } from "next/server";
import { discoveryListing } from "@/src/catalog/discovery";
import { withDirectoryTransactionReadiness } from "@/src/catalog/inspection";
import { loadCatalog } from "@/src/catalog/store";
import { catalogJson, claimQuery } from "@/src/catalog/http";
import { requestBaseUrl } from "@/src/catalog/publicUrl";
import { canonicalDemosAgentClaim } from "@/src/catalog/claimRef";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ primaryClaimRef: string }> },
) {
  // Next has already decoded the path segment once; a CF-2 escape such as
  // `%3A` inside a parameter is data and must not be decoded again.
  const claimRef = claimQuery((await params).primaryClaimRef, "primaryClaim");
  if ("refused" in claimRef) return claimRef.refused;
  const raw = claimRef.value;
  // CF-2: the `did` scheme token is case-insensitive on read; canonicalise it
  // before matching. Non-canonical key material stays raw and simply misses.
  const claim = canonicalDemosAgentClaim(raw) ?? raw;
  const seller = loadCatalog().sellers.find((s) => s.primaryClaim === claim);
  if (!seller) return NextResponse.json({ error: "seller not found" }, { status: 404 });
  const origin = requestBaseUrl(req);
  return catalogJson(req, {
    listings: seller.listings.filter(discoveryListing).map(withDirectoryTransactionReadiness),
    identity: seller.identityBundle ?? {
      profile: "legacy-sdk-v0.1",
      primaryClaim: seller.primaryClaim,
      assurance: "signing-key-only",
      identityLinks: seller.cci,
      limitation: "GCR identity links are not fresh DACS-2 verifiedBy results.",
    },
    reputation: {
      profile: "TP-1",
      ...seller.reputation,
      limitation: "Completion verification unavailable under TP-1. Completion and fault rates and numeric reputation scores are unavailable on testnet. Counts describe observed history, not verified completion; the catalog may be incomplete. Individual evidence remains available for inspection.",
    },
    deals: seller.deals,
  }, {
    lastModified: seller.lastIndexedAt,
    links: [
      { href: `${origin}/seller/${encodeURIComponent(seller.primaryClaim)}`, rel: "alternate", type: "text/html" },
      { href: `${origin}/schemas/listing-summary.schema.json`, rel: "describedby", type: "application/schema+json" },
    ],
  });
}
