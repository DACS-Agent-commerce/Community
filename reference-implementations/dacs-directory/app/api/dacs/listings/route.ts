/**
 * GET /api/dacs/listings — §6.3.6 catalog search endpoint.
 * MVP filters: category (dot-prefix), tag (repeatable), rail, cursor/limit.
 */
import { NextRequest, NextResponse } from "next/server";
import { loadCatalog } from "@/src/catalog/store";
import { parsePagination } from "@/src/catalog/pagination";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const category = q.get("category");
  const rail = q.get("rail");
  const tags = q.getAll("tag");
  // Catalog-side extension beyond §6.3.6: the §6.3.2.1 derived tier as a
  // filter (institutional | verified | self-declared).
  const identityTier = q.get("identityTier");
  const pagination = parsePagination(q.get("limit"), q.get("cursor"));
  if (!pagination.ok) {
    return NextResponse.json({ error: pagination.error }, { status: 400 });
  }
  const { limit, cursor } = pagination;

  const catalog = loadCatalog();
  const tierOf = new Map(catalog.sellers.map((s) => [
    s.primaryClaim,
    s.identityTier ?? (s.cci.length > 0 ? "verified" : "self-declared"),
  ]));
  const all = catalog.sellers.flatMap((s) => s.listings);
  const filtered = all.filter((l) => {
    if (category && l.offering.category !== category && !l.offering.category.startsWith(category + ".")) return false;
    if (identityTier && tierOf.get(l.seller.primaryClaim) !== identityTier) return false;
    if (rail && !(l.offering.rails ?? []).includes(rail)) return false;
    // Tags also match rails/delivery so pre-split catalogs keep working.
    const hay = [...l.offering.tags, ...(l.offering.rails ?? []), ...(l.offering.delivery ?? [])];
    if (tags.length && !tags.every((t) => hay.includes(t))) return false;
    return true;
  });
  const page = filtered.slice(cursor, cursor + limit);
  return NextResponse.json({
    listings: page,
    cursor: cursor + limit < filtered.length ? String(cursor + limit) : undefined,
    total: filtered.length,
  });
}
