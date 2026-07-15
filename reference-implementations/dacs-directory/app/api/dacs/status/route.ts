/**
 * GET /api/dacs/status — catalog freshness vs the chain.
 * The catalog is a cache (§6.3.6); this reports how stale it is: the scan
 * cursor, the chain's latest tx id (live nodeCall), and when the catalog
 * was last generated.
 */
import { NextRequest, NextResponse } from "next/server";
import { indexerDiagnostics, loadCatalog, loadScanState } from "@/src/catalog/store";
import { parseStatusDiagnosticsQuery } from "@/src/catalog/statusDiagnostics";

const RPC = (process.env.DEMOS_RPC ?? "https://demosnode.discus.sh/").replace(/\/$/, "");

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const diagnosticsQuery = parseStatusDiagnosticsQuery(req.nextUrl.searchParams);
  if (!diagnosticsQuery.ok) {
    return NextResponse.json({ error: diagnosticsQuery.error }, { status: 400 });
  }
  const catalog = loadCatalog();
  const scan = loadScanState();

  let chainLatestTx: number | null = null;
  try {
    const res = await fetch(RPC + "/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
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
    const json = (await res.json()) as { result?: number; response?: Array<{ id?: number }> };
    const id = json?.result === 200 ? json.response?.[0]?.id : undefined;
    if (typeof id === "number") chainLatestTx = id;
  } catch {
    /* node unreachable — report lag as unknown */
  }

  return NextResponse.json({
    generatedAt: catalog.generatedAt,
    syncedToTx: scan.lastSeenTxId,
    chainLatestTx,
    txsBehind: chainLatestTx !== null ? Math.max(0, chainLatestTx - scan.lastSeenTxId) : null,
    indexer: indexerDiagnostics({
      deadLetterLimit: diagnosticsQuery.deadLetterLimit,
      deadLetterLocator: diagnosticsQuery.deadLetterLocator,
    }),
  });
}
