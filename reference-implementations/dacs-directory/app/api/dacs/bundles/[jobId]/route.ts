import { NextRequest, NextResponse } from "next/server";
import { verifyBundleBinding } from "@/src/catalog/bundleBinding";
import { contentHash } from "@/src/catalog/canonical";
import { keysetPage, parseBindingPage } from "@/src/catalog/pagination";
import { loadScanState } from "@/src/catalog/store";

/**
 * DACS-1 §6.3.6: an unauthenticated read that serves every BB-4-valid BundleBinding this catalog
 * holds for the jobId, whoever signed it, as `{ bindings }`. The BB-6 per-signer budget applies only
 * when a consumer resolves a side, never to what the catalog serves.
 *
 * Paging is an optional Directory extension. `limit` caps a page and `cursor` is the content hash of
 * the last binding already read: bindings are ordered by content hash (not grouped by signer) and a
 * page starts after the cursor key, which need not still exist, so a reindex between pages cannot
 * make a page skip a binding present before and after it. A paged reply adds `total` and, while more
 * remain, the next `cursor`. A `cursor` without `limit` returns everything after the cursor.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  if (jobId.length < 1 || jobId.length > 160) {
    return NextResponse.json({ error: "jobId must be 1-160 characters" }, { status: 400 });
  }
  const page = parseBindingPage(request.nextUrl.searchParams.get("limit"), request.nextUrl.searchParams.get("cursor"));
  if (!page.ok) return NextResponse.json({ error: page.error }, { status: 400 });
  const stored = loadScanState().bundleBindings;
  const candidates = stored && Object.prototype.hasOwnProperty.call(stored, jobId) ? stored[jobId] ?? [] : [];
  const byContentHash = new Map(candidates.map((binding) => [contentHash(binding), binding]));
  const { values, next } = keysetPage([...byContentHash].map(([key, value]) => ({ key, value })), page);
  const bindings = (await Promise.all(values.map((binding) => verifyBundleBinding(binding))))
    .filter((binding) => binding !== null);
  if (page.limit === undefined) return NextResponse.json({ bindings });
  return NextResponse.json({ bindings, total: byContentHash.size, cursor: next });
}
