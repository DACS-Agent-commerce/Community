/**
 * GET /api/dacs/status — catalog freshness vs the chain.
 * The catalog is a cache (§6.3.6); this reports how stale it is: the scan
 * cursor, the chain's latest tx id (live nodeCall), and when the catalog
 * was last generated.
 */
import { NextRequest, NextResponse } from "next/server";
import { indexerDiagnostics, loadCatalog, loadScanState } from "@/src/catalog/store";
import {
  cursorProgressDiagnostics,
  parseStatusDiagnosticsQuery,
} from "@/src/catalog/statusDiagnostics";
import { chainResetRequired, chainResetThreshold, cursorAheadBy } from "@/src/catalog/chainContinuity";
import { catalogNodeDeployment } from "@/src/catalog/listingFinality";
import { storageResponseJson } from "@/src/catalog/artifactLimits";

const RPC = (process.env.DEMOS_RPC ?? "https://demosnode.discus.sh/").replace(/\/$/, "");

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const diagnosticsQuery = parseStatusDiagnosticsQuery(req.nextUrl.searchParams);
  if (!diagnosticsQuery.ok) {
    return NextResponse.json({ error: diagnosticsQuery.error }, { status: 400 });
  }
  const catalog = loadCatalog();
  const scan = loadScanState();
  // Deployment and tip each get a short budget, independent of indexing preflights.
  const signal = AbortSignal.timeout(3_000);
  const nodeDeployment = await catalogNodeDeployment(signal).catch(() => ({
    ok: false as const,
    unavailable: true,
    reason: signal.aborted ? "Demos node chain check timed out" : "could not read the Demos node's chain",
  }));

  let chainLatestTx: number | null = null;
  if (nodeDeployment.ok) {
    try {
      const res = await fetch(RPC + "/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(3_000),
        cache: "no-store",
        body: JSON.stringify({
          method: "nodeCall",
          params: [{
            type: "nodeCall", message: "getTransactions",
            sender: null, receiver: null, timestamp: null,
            data: { start: "latest", limit: 1 }, extra: "",
          }],
        }),
      });
      if (!res.ok) throw new Error("chain tip transport failed");
      const json = (await storageResponseJson(res)) as { result?: number; response?: Array<{ id?: number }> };
      const rows = json?.result === 200 && Array.isArray(json.response) && json.response.length <= 1
        ? json.response : [];
      const id = rows[0]?.id;
      if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) chainLatestTx = id;
    } catch {
      /* node unreachable — report lag as unknown */
    }
  }

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
