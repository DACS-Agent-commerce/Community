/**
 * GET /api/dacs/sellers/{primaryClaimRef} — §6.3.6 seller view:
 * listings + catalog-cached identity (CCI badges) + reputation (per DACS-5,
 * derived only from chain-verified bundles; re-derivable client-side).
 */
import { NextRequest, NextResponse } from "next/server";
import { loadCatalog } from "@/src/catalog/store";
import { catalogJson } from "@/src/catalog/http";
import { requestBaseUrl } from "@/src/catalog/publicUrl";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ primaryClaimRef: string }> },
) {
  const { primaryClaimRef } = await params;
  const claim = decodeURIComponent(primaryClaimRef);
  const seller = loadCatalog().sellers.find((s) => s.primaryClaim === claim);
  if (!seller) return NextResponse.json({ error: "seller not found" }, { status: 404 });
  const origin = requestBaseUrl(req);
  return catalogJson(req, {
    listings: seller.listings,
    identity: seller.identityBundle ?? {
      profile: "legacy-sdk-v0.1",
      primaryClaim: seller.primaryClaim,
      assurance: "signing-key-only",
      identityLinks: seller.cci,
      limitation: "GCR identity links are not fresh DACS-2 verifiedBy results.",
    },
    reputation: {
      profile: "dacs-5-scalar-derivation-v1",
      ...seller.reputation,
      observedTransactionalVolume: [],
      transactionCountByCurrency: [],
      limitation: "Two-sided reconciliation, perspective/fault metrics and neutral exclusions are applied. Rating and volume records are not yet resolved, so those fields remain null/empty.",
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
