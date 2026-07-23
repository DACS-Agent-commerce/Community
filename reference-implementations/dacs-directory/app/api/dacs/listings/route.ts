/**
 * GET /api/dacs/listings — §6.3.6 catalog search endpoint.
 * Normative filters plus q/profile directory extensions.
 */
import { NextRequest, NextResponse } from "next/server";
import { activeCatalogListings, primaryClaimMatches } from "@/src/catalog/discovery";
import { loadCatalog } from "@/src/catalog/store";
import { parsePagination } from "@/src/catalog/pagination";
import { catalogJson } from "@/src/catalog/http";
import { requestBaseUrl } from "@/src/catalog/publicUrl";
import { withDirectoryInspectionAffordance } from "@/src/catalog/inspection";
import { artifactProfiles } from "@/src/catalog/contracts";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const category = q.get("category");
  const rail = q.get("rail");
  const tags = q.getAll("tag");
  const credential = q.get("credential");
  const primaryClaim = q.get("primaryClaim");
  const priceMax = q.get("priceMax");
  const minCompletionRate = q.get("minCompletionRate");
  const minRating = q.get("minRating");
  const query = q.get("q")?.trim().toLowerCase();
  const profile = q.get("profile");
  const identityTier = q.get("identityTier");
  const numericFilters: Array<[string, string | null, number, number]> = [
    ["priceMax", priceMax, 0, Number.POSITIVE_INFINITY],
    ["minCompletionRate", minCompletionRate, 0, 1],
    ["minRating", minRating, 0, 5],
  ];
  for (const [name, raw, min, max] of numericFilters) {
    const value = raw === null ? null : Number(raw);
    if (value !== null && (!Number.isFinite(value) || value < min || value > max)) {
      return NextResponse.json({ error: `${name} is outside its allowed range` }, { status: 400 });
    }
  }
  if (profile && !(artifactProfiles as readonly string[]).includes(profile)) {
    return NextResponse.json({ error: "unsupported artifact profile" }, { status: 400 });
  }
  if (identityTier && !["institutional", "verified", "self-declared"].includes(identityTier)) {
    return NextResponse.json({ error: "unsupported identityTier" }, { status: 400 });
  }
  const pagination = parsePagination(q.get("limit"), q.get("cursor"));
  if (!pagination.ok) {
    return NextResponse.json({ error: pagination.error }, { status: 400 });
  }
  const { limit, cursor } = pagination;

  const catalog = loadCatalog();
  // Discovery only advertises offers that remain active. Revoked listings stay
  // available on the seller history/detail surfaces with an explicit status.
  const all = activeCatalogListings(catalog);
  const tierByClaim = new Map(catalog.sellers.map((seller) => [seller.primaryClaim, seller.identityTier ?? "self-declared"]));
  const filtered = all.filter((l) => {
    if (category && l.offering.category !== category && !l.offering.category.startsWith(category + ".")) return false;
    if (rail && !(l.offering.rails ?? []).includes(rail)) return false;
    if (profile && l.artifactProfile !== profile) return false;
    if (identityTier && tierByClaim.get(l.seller.primaryClaim) !== identityTier) return false;
    if (primaryClaim && !primaryClaimMatches(l.seller.primaryClaim, primaryClaim)) return false;
    if (credential) {
      const required = Array.isArray(l.buyerRequirement?.required)
        ? l.buyerRequirement.required as Array<Record<string, unknown>> : [];
      if (!required.some((item) => item.scheme === credential)) return false;
    }
    if (priceMax !== null) {
      const max = Number(priceMax);
      const price = Number(l.pricing.priceHint);
      if (!Number.isFinite(max) || max < 0 || !Number.isFinite(price) || price > max) return false;
    }
    if (minCompletionRate !== null) {
      const min = Number(minCompletionRate);
      if (!Number.isFinite(min) || min < 0 || min > 1 || l.reputationHint?.completionRate == null || l.reputationHint.completionRate < min) return false;
    }
    if (minRating !== null) {
      const min = Number(minRating);
      if (!Number.isFinite(min) || min < 0 || min > 5 || l.reputationHint?.averageSellerRating == null || l.reputationHint.averageSellerRating < min) return false;
    }
    if (tags.length && !tags.every((t) => l.offering.tags.includes(t))) return false;
    if (query) {
      const search = [l.offering.title, l.offering.description ?? "", l.offering.category, ...l.offering.tags,
        ...(l.offering.rails ?? []), ...(l.offering.delivery ?? []),
        ...(l.offering.negotiation ?? []), l.pricing.kind ?? "", l.seller.displayName].join(" ").toLowerCase().replaceAll("-", " ");
      if (!search.includes(query.replaceAll("-", " "))) return false;
    }
    return true;
  });
  const origin = requestBaseUrl(req);
  const page = filtered
    .slice(cursor, cursor + limit)
    .map((listing) => withDirectoryInspectionAffordance(listing));
  const body = {
    listings: page,
    cursor: cursor + limit < filtered.length ? String(cursor + limit) : undefined,
    total: filtered.length,
  };
  const self = new URL(`${req.nextUrl.pathname}${req.nextUrl.search}`, origin);
  const links = [
    { href: self.toString(), rel: "self", type: "application/json" },
    { href: `${origin}/schemas/listing-summary.schema.json`, rel: "describedby", type: "application/schema+json" },
  ];
  if (body.cursor) {
    const next = new URL(self);
    next.searchParams.set("cursor", body.cursor);
    links.push({ href: next.toString(), rel: "next", type: "application/json" });
  }
  return catalogJson(req, body, { links, lastModified: catalog.generatedAt });
}
