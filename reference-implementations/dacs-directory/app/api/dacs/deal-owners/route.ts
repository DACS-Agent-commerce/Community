/** GET /api/dacs/deal-owners?jobId=[&bundleRef=] — catalog lookup for a deal's anchor owners
 *  (used when a bundle copy doesn't name the buyer, e.g. seller-anchored copies). */
import { NextRequest, NextResponse } from "next/server";
import { canonicalProgramOwner, loadCatalog, loadScanState } from "@/src/catalog/store";
import type { RegisteredDeal } from "@/src/catalog/types";

const party = (claim: string) => claim ? canonicalProgramOwner(claim) : "";

/**
 * A jobId is unique only per producer, so every catalog and scanned entry for it is
 * considered; `bundleRef` narrows them to the deal holding that bundle copy. Owners are
 * reported only when exactly one distinct, attributed deal remains.
 */
export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId")?.trim();
  if (!jobId) return NextResponse.json({ error: "need ?jobId=" }, { status: 400 });
  const bundleRef = req.nextUrl.searchParams.get("bundleRef")?.trim() || undefined;
  const holds = (deal: RegisteredDeal) => !bundleRef || deal.buyerBundleRef === bundleRef || deal.sellerBundleRef === bundleRef;
  const catalog = loadCatalog().sellers.flatMap((seller) => seller.deals).filter((deal) => deal.jobId === jobId && holds(deal));
  // A scanned entry already indexed into the catalog is represented by its catalog entry,
  // whose bundle refs may have been resolved through bindings.
  const indexed = new Set(catalog.map((deal) => `${party(deal.owners.buyer)}\n${party(deal.owners.seller)}`));
  const scanned = Object.values(loadScanState().deals).filter((deal) => deal.jobId === jobId && holds(deal) &&
    !indexed.has(`${party(deal.owners.buyer)}\n${party(deal.owners.seller)}`));
  const distinct = new Map<string, RegisteredDeal>();
  for (const deal of [...catalog, ...scanned]) {
    distinct.set(JSON.stringify([party(deal.owners.buyer), party(deal.owners.seller), deal.buyerBundleRef, deal.sellerBundleRef ?? null]), deal);
  }
  const [only] = distinct.values();
  if (distinct.size === 1 && only.owners.seller) {
    return NextResponse.json({
      owners: only.owners,
      buyerBundleRef: only.buyerBundleRef,
      sellerBundleRef: only.sellerBundleRef ?? null,
    });
  }
  return NextResponse.json({ owners: null, buyerBundleRef: null });
}
