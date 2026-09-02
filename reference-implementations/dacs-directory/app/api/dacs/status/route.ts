/**
 * GET /api/dacs/status — catalog freshness vs the chain.
 * The catalog is a cache (§6.3.6); this reports how stale it is: the scan
 * cursor, the chain's latest tx id (live nodeCall), and when the catalog
 * was last generated.
 */
import { NextResponse } from "next/server";
import { latestConfirmedTransactionId } from "@/src/catalog/chain";
import {
  loadCatalog,
  loadIndexerRuntimeState,
  loadScanState,
} from "@/src/catalog/store";

export const dynamic = "force-dynamic";

let fallbackTip: { value: number | null; observedAt: number } | null = null;

async function currentTip(indexerRunning: boolean, observed: number | null | undefined) {
  if (indexerRunning && observed !== undefined) return observed;
  if (fallbackTip && Date.now() - fallbackTip.observedAt < 10_000) return fallbackTip.value;
  const value = await latestConfirmedTransactionId();
  fallbackTip = { value, observedAt: Date.now() };
  return value;
}

export async function GET() {
  const catalog = loadCatalog();
  const scan = loadScanState();
  const runtime = loadIndexerRuntimeState();
  const heartbeatWindow = Math.max(30_000, (runtime?.pollIntervalMs ?? 0) * 5);
  const indexerRunning = !!runtime?.running && Date.now() - runtime.heartbeatAt <= heartbeatWindow;
  const chainLatestTx = await currentTip(indexerRunning, runtime?.lastObservedChainTx);

  return NextResponse.json({
    generatedAt: catalog.generatedAt,
    catalogRevision: catalog.generatedAt,
    syncedToTx: scan.lastSeenTxId,
    chainLatestTx,
    txsBehind: chainLatestTx !== null ? Math.max(0, chainLatestTx - scan.lastSeenTxId) : null,
    indexerRunning,
    indexing: indexerRunning && !!runtime?.indexing,
    lastStartedAt: runtime?.lastStartedAt ?? null,
    lastCompletedAt: runtime?.lastCompletedAt ?? null,
    lastError: runtime?.lastError ?? null,
  });
}
