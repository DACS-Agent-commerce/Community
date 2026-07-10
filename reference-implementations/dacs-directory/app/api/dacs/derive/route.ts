/**
 * GET /api/dacs/derive?claim=<did>&serviceId=<id>
 * Resolves the catalog's logical→native binding, then re-reads the anchor and
 * verifies content hash, seller signature, and substrate owner. Native Demos
 * addresses include the write nonce and therefore cannot be recomputed from a
 * claim/service id alone.
 */
import { NextRequest, NextResponse } from "next/server";
import { readAnchorRecord } from "@/src/catalog/chain";
import { loadCatalog } from "@/src/catalog/store";
import { ownerClaim, verifyListing } from "@/src/catalog/listingVerification";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const claim = q.get("claim")?.trim();
  const serviceId = q.get("serviceId")?.trim();
  if (!claim || !serviceId) {
    return NextResponse.json({ error: "need ?claim=&serviceId=" }, { status: 400 });
  }
  const summary = loadCatalog().sellers
    .find((s) => s.primaryClaim === claim)
    ?.listings.find((l) => l.listingId === serviceId);
  if (!summary) {
    return NextResponse.json({ found: false, valid: false, error: "listing binding is not indexed" }, { status: 404 });
  }
  const address = summary.anchor.locator;
  const anchored = await readAnchorRecord(address);
  const verified = anchored ? await verifyListing(anchored.data) : null;
  const valid = !!verified && verified.contentHash === summary.contentHash && ownerClaim(anchored?.owner) === claim.toLowerCase();
  return NextResponse.json({
    address,
    found: !!anchored,
    valid,
    ownedByClaim: valid,
    title: verified?.listing.name ?? null,
  });
}
