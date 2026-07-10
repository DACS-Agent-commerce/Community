/**
 * GET /api/dacs/sellers/{primaryClaimRef} — §6.3.6 seller view:
 * listings + catalog-cached identity (CCI badges) + reputation (per DACS-5,
 * derived only from chain-verified bundles; re-derivable client-side).
 */
import { NextRequest, NextResponse } from "next/server";
import { loadCatalog } from "@/src/catalog/store";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ primaryClaimRef: string }> },
) {
  const { primaryClaimRef } = await params;
  const claim = decodeURIComponent(primaryClaimRef);
  const seller = loadCatalog().sellers.find((s) => s.primaryClaim === claim);
  if (!seller) return NextResponse.json({ error: "seller not found" }, { status: 404 });
  return NextResponse.json({
    listings: seller.listings,
    identity: { primaryClaim: seller.primaryClaim, displayName: seller.displayName, cci: seller.cci },
    reputation: seller.reputation,
    deals: seller.deals,
  });
}
