/** GET /api/dacs/deal-owners?jobId= — catalog lookup for a deal's anchor owners
 *  (used when a bundle copy doesn't name the buyer, e.g. seller-anchored copies). */
import { NextRequest, NextResponse } from "next/server";
import { loadCatalog, loadScanState } from "@/src/catalog/store";

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId")?.trim();
  if (!jobId) return NextResponse.json({ error: "need ?jobId=" }, { status: 400 });
  for (const s of loadCatalog().sellers) {
    const d = s.deals.find((x) => x.jobId === jobId);
    if (d) {
      return NextResponse.json({
        owners: d.owners,
        buyerBundleRef: d.buyerBundleRef,
        sellerBundleRef: d.sellerBundleRef ?? null,
      });
    }
  }
  const scanned = loadScanState().deals[jobId];
  if (scanned) {
    return NextResponse.json({
      owners: scanned.owners,
      buyerBundleRef: scanned.buyerBundleRef,
      sellerBundleRef: scanned.sellerBundleRef ?? null,
    });
  }
  return NextResponse.json({ owners: null, buyerBundleRef: null });
}
