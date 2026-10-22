/**
 * GET /api/dacs/status — catalog freshness vs the chain.
 * The catalog is a cache (§6.3.6); this reports how stale it is: the scan
 * cursor, the chain's latest tx id (node observation cached for 30s), and when the catalog
 * was last generated.
 */
import { NextRequest, NextResponse } from "next/server";
import { indexerDiagnostics, loadCatalog, loadScanState } from "@/src/catalog/store";
import {
  cursorProgressDiagnostics,
  parseStatusDiagnosticsQuery,
} from "@/src/catalog/statusDiagnostics";
import { chainResetRequired, chainResetThreshold, cursorAheadBy } from "@/src/catalog/chainContinuity";
import { statusNodeObservationCache } from "@/src/catalog/statusNodeObservation";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const diagnosticsQuery = parseStatusDiagnosticsQuery(req.nextUrl.searchParams);
  if (!diagnosticsQuery.ok) {
    return NextResponse.json({ error: diagnosticsQuery.error }, { status: 400 });
  }
  const catalog = loadCatalog();
  const scan = loadScanState();
  const { nodeDeployment, chainLatestTx } = await statusNodeObservationCache.read();

  const resetThreshold = chainResetThreshold();
  const aheadBy = chainLatestTx !== null ? cursorAheadBy(scan, chainLatestTx) : null;
  const cursorProgress = cursorProgressDiagnostics(scan, chainLatestTx);
  return NextResponse.json({
    generatedAt: catalog.generatedAt,
    legacyVetUnsupportedDeals: catalog.sellers.reduce((count, seller) => count + (seller.deals ?? []).filter(
      (deal) => deal.verificationLimitation === "legacy-vet-unsupported",
    ).length, 0),
    nodeDeployment,
    syncedToTx: scan.lastSeenTxId,
    chainLatestTx,
    txsBehind: chainLatestTx !== null ? Math.max(0, chainLatestTx - scan.lastSeenTxId) : null,
    cursorAheadBy: aheadBy,
    chainResetSuspected: chainLatestTx !== null
      ? chainResetRequired(scan, chainLatestTx, resetThreshold)
      : null,
    ...cursorProgress,
    indexer: indexerDiagnostics({
      deadLetterLimit: diagnosticsQuery.deadLetterLimit,
      deadLetterLocator: diagnosticsQuery.deadLetterLocator,
    }),
  });
}
