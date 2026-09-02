/**
 * GET /api/dacs/listings — §6.3.6 catalog search endpoint.
 * MVP filters: category (dot-prefix), tag (repeatable), rail, cursor/limit.
 */
import { NextRequest, NextResponse } from "next/server";
import { activeCatalogListings } from "@/src/catalog/discovery";
import { loadCatalog } from "@/src/catalog/store";
import { parsePagination } from "@/src/catalog/pagination";
import { sameCanonicalClaimIdentity } from "@kynesyslabs/dacs/identity";
import { DACS_MARKET_MEDIA_TYPE } from "@/src/catalog/agentManifest";

function boundedNumber(raw: string | null, min: number, max: number): number | null | "invalid" {
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : "invalid";
}

function decimalParts(value: string): { digits: bigint; scale: number } | null {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(value);
  if (!match) return null;
  return { digits: BigInt(match[1] + (match[2] ?? "")), scale: match[2]?.length ?? 0 };
}

function decimalLte(left: string, right: string): boolean {
  const a = decimalParts(left);
  const b = decimalParts(right);
  if (!a || !b) return false;
  const scale = Math.max(a.scale, b.scale);
  return a.digits * 10n ** BigInt(scale - a.scale) <= b.digits * 10n ** BigInt(scale - b.scale);
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const category = q.get("category");
  const rail = q.get("rail");
  const tags = q.getAll("tag");
  const credential = q.get("credential");
  const primaryClaim = q.get("primaryClaim");
  const priceMax = q.get("priceMax");
  const minCompletionRate = boundedNumber(q.get("minCompletionRate"), 0, 1);
  const minRating = boundedNumber(q.get("minRating"), 0, 5);
  // Catalog-side extension beyond §6.3.6: the §6.3.2.1 derived tier as a
  // filter (institutional | verified | self-declared).
  const identityTier = q.get("identityTier");
  const pagination = parsePagination(q.get("limit"), q.get("cursor"));
  if (!pagination.ok) {
    return NextResponse.json({ error: pagination.error }, { status: 400 });
  }
  if (minCompletionRate === "invalid" || minRating === "invalid" || (priceMax && !decimalParts(priceMax))) {
    return NextResponse.json({ error: "invalid numeric catalog filter" }, { status: 400 });
  }
  const { limit, cursor } = pagination;

  const catalog = loadCatalog();
  const tierOf = new Map(catalog.sellers.map((s) => [
    s.primaryClaim,
    s.identityTier ?? "self-declared",
  ]));
  const credentialsOf = new Map(catalog.sellers.map((s) => [
    s.primaryClaim,
    // Raw GCR/CCI links are display-only until authenticated provenance is
    // available. Do not satisfy the SDK credential filter with them.
    new Set<string>(),
  ]));
  // Discovery only advertises offers that remain active. Revoked listings stay
  // available on the seller history/detail surfaces with an explicit status.
  const all = activeCatalogListings(catalog);
  const filtered = all.filter((l) => {
    if (category && l.offering.category !== category && !l.offering.category.startsWith(category + ".")) return false;
    if (primaryClaim && !sameCanonicalClaimIdentity(l.seller.primaryClaim, primaryClaim)) return false;
    if (credential && !credentialsOf.get(l.seller.primaryClaim)?.has(credential)) return false;
    if (identityTier && tierOf.get(l.seller.primaryClaim) !== identityTier) return false;
    if (rail && !(l.offering.rails ?? []).includes(rail)) return false;
    if (priceMax && (!l.pricing.priceHint || !decimalLte(l.pricing.priceHint, priceMax))) return false;
    if (minCompletionRate !== null && (l.reputationHint?.completionRate ?? -1) < minCompletionRate) return false;
    if (minRating !== null && (l.reputationHint?.averageSellerRating ?? -1) < minRating) return false;
    // Tags also match rails/delivery so pre-split catalogs keep working.
    const hay = [...l.offering.tags, ...(l.offering.rails ?? []), ...(l.offering.delivery ?? [])];
    if (tags.length && !tags.every((t) => hay.includes(t))) return false;
    return true;
  });
  const page = filtered.slice(cursor, cursor + limit);
  const response = NextResponse.json({
    listings: page,
    cursor: cursor + limit < filtered.length ? String(cursor + limit) : undefined,
    total: filtered.length,
  });
  response.headers.set(
    "Link",
    `</.well-known/dacs.json>; rel="service-desc"; type="${DACS_MARKET_MEDIA_TYPE}"`,
  );
  response.headers.set("DACS-Version", "1");
  return response;
}
