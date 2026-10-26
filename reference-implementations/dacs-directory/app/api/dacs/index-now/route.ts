/**
 * POST /api/dacs/index-now { claim } — index one registration immediately
 * (fresh publishes shouldn't wait for the next timer pass). Full chain
 * verification and the same chain pin as the batch path. It runs no crawl, so
 * crawl-derived diagnostics remain; verified owner pointer removals can clear
 * owner notices.
 */
import { NextRequest, NextResponse } from "next/server";
import { indexRegistration } from "@/src/catalog/indexer";
import { catalogNodeDeployment } from "@/src/catalog/listingFinality";
import { genesisReplayPending } from "@/src/catalog/scanState";
import { requireAdmin } from "@/src/catalog/security";
import { loadCatalog, loadRegistrations, loadScanState, saveCatalog, withDataLock } from "@/src/catalog/store";

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { claim?: string } | null;
  const claim = body?.claim?.trim();
  if (!claim) return NextResponse.json({ error: "need { claim }" }, { status: 400 });
  const reg = loadRegistrations().find((r) => r.primaryClaim === claim);
  if (!reg) return NextResponse.json({ error: "no registration for that claim" }, { status: 404 });

  return withDataLock("reindex", async () => {
    // As in reindexAll: nothing from a node outside the pinned chain
    // reaches the public catalog, and a node that cannot be read changes nothing.
    const deployment = await catalogNodeDeployment().catch(() => null);
    if (!deployment) {
      return NextResponse.json({ error: "could not read the Demos node's chain; catalog not updated" }, { status: 503 });
    }
    if (!deployment.ok) {
      return NextResponse.json({ error: `catalog not updated: ${deployment.reason}` }, { status: 409 });
    }
    // A catalog recorded under another chain is replaced by the next full reindex, not merged into.
    // A legacy scan state with no recorded chain is left alone.
    const scanState = loadScanState();
    const recordedChain = scanState.chainIdentity;
    if (recordedChain !== undefined && recordedChain !== deployment.chainIdentity) {
      return NextResponse.json({ error: "catalog not updated: it was built on another chain; run a full reindex first" }, { status: 409 });
    }
    // Until the replay from genesis ends, older withdrawals of the registered listing may be unscanned.
    if (genesisReplayPending(scanState)) {
      return NextResponse.json({ error: "catalog not updated: the replay from genesis has not finished; run a full reindex first" }, { status: 409 });
    }
    const catalog = loadCatalog();
    const prior = catalog.sellers.find((s) => s.primaryClaim === claim);
    const record = await indexRegistration({ ...reg, discoveryIncomplete: true }, prior);
    const i = catalog.sellers.findIndex((s) => s.primaryClaim === claim);
    if (i >= 0) catalog.sellers[i] = record;
    else catalog.sellers.push(record);
    catalog.generatedAt = Date.now();
    saveCatalog(catalog);
    return NextResponse.json({
      ok: true,
      nodeBuildWarning: deployment.warning,
      listings: record.listings.length,
      verifiedDeals: record.deals.filter((d) => d.refsVerified).length,
    });
  });
}
