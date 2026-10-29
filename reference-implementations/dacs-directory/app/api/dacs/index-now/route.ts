/**
 * POST /api/dacs/index-now { claim } — index one registration immediately
 * (fresh publishes shouldn't wait for the next timer pass). Full chain
 * verification and the same chain gate as the batch path. It runs no crawl;
 * saved publisher-signed declarations and owner evidence still apply.
 */
import { NextRequest, NextResponse } from "next/server";
import { scanStateCurrent, servedCatalogChain, servedChainUnchanged } from "@/src/catalog/chainGate";
import { indexRegistration } from "@/src/catalog/indexer";
import { requireAdmin } from "@/src/catalog/security";
import { openChainReadWindow, commitChainReadWindow, revertChainReadWindow, loadStoredCatalog, loadRegistrations, loadScanState, loadCatalogChain, invalidateCatalogChain, publishCatalogChain, withDataLock } from "@/src/catalog/store";

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { claim?: string } | null;
  const claim = body?.claim?.trim();
  if (!claim) return NextResponse.json({ error: "need { claim }" }, { status: 400 });
  const reg = loadRegistrations().find((r) => r.primaryClaim === claim);
  if (!reg) return NextResponse.json({ error: "no registration for that claim" }, { status: 404 });

  return withDataLock("reindex", async () => {
    revertChainReadWindow();
    const served = await servedCatalogChain();
    if (!served.ok) return NextResponse.json({ error: `catalog not updated: ${served.cause}` }, { status: served.status });
    // Until a complete pass on this chain has been scanned, older withdrawals may be missing:
    // another recorded chain, a legacy or reset state, an unfinished replay, an old schema.
    const state = loadScanState();
    if (!scanStateCurrent(state, served.chainIdentity, loadCatalogChain())) {
      return NextResponse.json({ error: "catalog not updated: no complete reindex on this chain yet; run a full reindex first" },
        { status: 409 });
    }
    const catalog = loadStoredCatalog();
    const prior = catalog.sellers.find((s) => s.primaryClaim === claim);
    invalidateCatalogChain(served.chainIdentity);
    openChainReadWindow();
    try {
      const record = await indexRegistration(reg, prior);
      const unchanged = await servedChainUnchanged(served.chainIdentity);
      if (!unchanged.ok) {
        return NextResponse.json({ error: `catalog not updated: ${unchanged.cause}` }, { status: unchanged.status });
      }
      const i = catalog.sellers.findIndex((s) => s.primaryClaim === claim);
      if (i >= 0) catalog.sellers[i] = record;
      else catalog.sellers.push(record);
      catalog.generatedAt = Date.now();
      commitChainReadWindow(() => publishCatalogChain(catalog, state, served.chainIdentity));
      return NextResponse.json({
        ok: true,
        nodeBuildWarning: served.warning,
        listings: record.listings.length,
        verifiedDeals: record.deals.filter((d) => d.refsVerified).length,
      });
    } finally {
      revertChainReadWindow();
    }
  });
}
