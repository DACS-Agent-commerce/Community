/** GET /api/dacs/deal-owners?jobId=[&bundleRef=] — catalog lookup for a deal's anchor owners
 *  (used when a bundle copy doesn't name the buyer, e.g. seller-anchored copies). */
import { NextRequest, NextResponse } from "next/server";
import { canonicalDemosAgentClaim } from "@/src/catalog/claimRef";
import { ownArray } from "@/src/catalog/scanState";
import { artifactOwner, canonicalProgramOwner, loadCatalog, loadScanState } from "@/src/catalog/store";
import type { RegisteredDeal } from "@/src/catalog/types";

const party = (claim: string) => claim ? canonicalProgramOwner(claim) : "";
const parties = (deal: RegisteredDeal) => `${party(deal.owners.buyer)}\n${party(deal.owners.seller)}`;
/** A deal without an attributed seller has no seller copy. */
const sellerRef = (deal: RegisteredDeal) => deal.owners.seller ? deal.sellerBundleRef : undefined;

/**
 * A jobId is unique only per producer, so every catalog and scanned entry for it is
 * considered. An entry counts only when each bundle ref it carries is bound to the party
 * it is reported for: that party owns the storage program, or that party's verified
 * BundleBinding for the role names the address. `bundleRef` then narrows the entries to
 * the deal holding that copy. Owners are reported only when exactly one distinct,
 * attributed deal remains.
 */
export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId")?.trim();
  if (!jobId) return NextResponse.json({ error: "need ?jobId=" }, { status: 400 });
  const bundleRef = req.nextUrl.searchParams.get("bundleRef")?.trim() || undefined;
  const state = loadScanState();
  const bindings = ownArray(state.bundleBindings, jobId);
  const boundTo = (ref: string, claim: string, role: "buyer" | "seller") => {
    const holder = canonicalDemosAgentClaim(claim);
    return holder !== null && (artifactOwner(ref) === party(claim) || bindings.some((binding) =>
      binding.role === role && binding.nativeAddress === ref && canonicalDemosAgentClaim(binding.signer) === holder));
  };
  const bound = (deal: RegisteredDeal) => boundTo(deal.buyerBundleRef, deal.owners.buyer, "buyer") &&
    (!sellerRef(deal) || boundTo(sellerRef(deal)!, deal.owners.seller, "seller"));
  const catalog = loadCatalog().sellers.flatMap((seller) => seller.deals).filter((deal) => deal.jobId === jobId && bound(deal));
  // A scanned entry already indexed into the catalog is represented by its catalog entry,
  // whose bundle refs may have been resolved through bindings, whichever ref is requested.
  const indexed = new Set(catalog.map(parties));
  const scanned = Object.values(state.deals).filter((deal) => deal.jobId === jobId && !indexed.has(parties(deal)) && bound(deal));
  const holds = (deal: RegisteredDeal) => !bundleRef || deal.buyerBundleRef === bundleRef || sellerRef(deal) === bundleRef;
  const distinct = new Map<string, RegisteredDeal>();
  for (const deal of [...catalog, ...scanned].filter(holds)) {
    distinct.set(JSON.stringify([party(deal.owners.buyer), party(deal.owners.seller), deal.buyerBundleRef, sellerRef(deal) ?? null]), deal);
  }
  const [only] = distinct.values();
  if (distinct.size === 1 && only.owners.seller) {
    return NextResponse.json({
      owners: only.owners,
      buyerBundleRef: only.buyerBundleRef,
      sellerBundleRef: sellerRef(only) ?? null,
    });
  }
  return NextResponse.json({ owners: null, buyerBundleRef: null });
}
