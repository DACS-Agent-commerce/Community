import { NextResponse } from "next/server";
import { verifyBundleBinding } from "@/src/catalog/bundleBinding";
import { loadScanState } from "@/src/catalog/store";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  if (jobId.length < 1 || jobId.length > 160) {
    return NextResponse.json({ error: "jobId must be 1-160 characters" }, { status: 400 });
  }
  const candidates = loadScanState().bundleBindings?.[jobId] ?? [];
  const bindings = (await Promise.all(candidates.map(verifyBundleBinding)))
    .filter((binding) => binding !== null);
  return NextResponse.json({ bindings });
}
