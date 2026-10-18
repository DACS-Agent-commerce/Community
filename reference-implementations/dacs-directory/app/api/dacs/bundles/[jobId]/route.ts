import { NextRequest, NextResponse } from "next/server";
import { verifyBundleBinding } from "@/src/catalog/bundleBinding";
import { parsePagination } from "@/src/catalog/pagination";
import { loadScanState } from "@/src/catalog/store";

/**
 * DACS-1 §6.3.6: an unauthenticated read that serves every BB-4-valid BundleBinding this catalog
 * holds for the jobId, whoever signed it, in pages. The BB-6 per-signer budget applies only when
 * a consumer resolves a side, never to what the catalog serves.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  if (jobId.length < 1 || jobId.length > 160) {
    return NextResponse.json({ error: "jobId must be 1-160 characters" }, { status: 400 });
  }
  const page = parsePagination(request.nextUrl.searchParams.get("limit"), request.nextUrl.searchParams.get("cursor"));
  if (!page.ok) return NextResponse.json({ error: page.error }, { status: 400 });
  const stored = loadScanState().bundleBindings;
  const candidates = stored && Object.prototype.hasOwnProperty.call(stored, jobId) ? stored[jobId] ?? [] : [];
  const slice = candidates.slice(page.cursor, page.cursor + page.limit);
  const bindings = (await Promise.all(slice.map((binding) => verifyBundleBinding(binding))))
    .filter((binding) => binding !== null);
  const next = page.cursor + page.limit;
  return NextResponse.json({ bindings, total: candidates.length, cursor: next < candidates.length ? String(next) : undefined });
}
