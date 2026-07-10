/** GET /api/dacs/listings/{listingId}/{version} — §6.3.6: the listing summary + anchor. */
import { NextRequest, NextResponse } from "next/server";
import { loadCatalog } from "@/src/catalog/store";
import { readAnchor } from "@/src/catalog/chain";
import { verifyListing } from "@/src/catalog/listingVerification";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ listingId: string; version: string }> },
) {
  const { listingId, version } = await params;
  const hit = loadCatalog()
    .sellers.flatMap((s) => s.listings)
    .find((l) => l.listingId === listingId && String(l.version) === version);
  if (!hit) return NextResponse.json({ error: "listing not found" }, { status: 404 });
  const raw = await readAnchor(hit.anchor.locator);
  const verified = raw ? await verifyListing(raw) : null;
  if (!verified || verified.contentHash !== hit.contentHash) {
    return NextResponse.json({ error: "listing anchor failed verification" }, { status: 502 });
  }
  const actualId = typeof verified.scope.listingId === "string"
    ? verified.scope.listingId
    : verified.listing.serviceId;
  const actualVersion = verified.scope.listingVersion ?? verified.scope.version ?? 1;
  if (actualId !== listingId || String(actualVersion) !== version) {
    return NextResponse.json({ error: "listing anchor does not match requested id/version" }, { status: 502 });
  }
  return NextResponse.json(raw);
}
