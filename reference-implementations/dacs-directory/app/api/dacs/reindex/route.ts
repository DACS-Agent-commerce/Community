/**
 * POST /api/dacs/reindex — full reindex to the chain tip (the UI's refresh
 * button). Scans new txs, re-verifies everything, rewrites the catalog.
 * Concurrent requests join the in-flight run instead of racing the flat-file
 * store. Can take a minute or two: every bundle is re-verified against chain.
 */
import { NextRequest, NextResponse } from "next/server";
import { reindexAll, type ReindexSummary } from "@/src/catalog/reindexCore";
import { requireAdmin } from "@/src/catalog/security";
import { withDataLock } from "@/src/catalog/store";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

let inFlight: Promise<ReindexSummary> | null = null;

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const joined = inFlight !== null;
  const run = (inFlight ??= withDataLock("reindex", () => reindexAll()).finally(() => {
    inFlight = null;
  }));
  try {
    const summary = await run;
    return NextResponse.json({ ok: true, joined, ...summary });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "reindex failed" },
      { status: 500 },
    );
  }
}
