import type { MetadataRoute } from "next";
import { directoryBaseUrl } from "@/src/catalog/publicUrl";
import { loadCatalog } from "@/src/catalog/store";

export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = directoryBaseUrl();
  const catalog = loadCatalog();
  const modified = catalog.generatedAt ? new Date(catalog.generatedAt) : new Date();
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: base, lastModified: modified, changeFrequency: "hourly", priority: 1 },
    { url: `${base}/try`, changeFrequency: "weekly", priority: 0.9 },
    { url: `${base}/try-chat`, changeFrequency: "monthly", priority: 0.7 },
    { url: `${base}/how-it-works`, changeFrequency: "monthly", priority: 0.7 },
    { url: `${base}/verify`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${base}/register`, changeFrequency: "monthly", priority: 0.6 },
  ];
  const sellerRoutes: MetadataRoute.Sitemap = catalog.sellers.map((seller) => ({
    url: `${base}/seller/${encodeURIComponent(seller.primaryClaim)}`,
    lastModified: new Date(seller.lastIndexedAt), changeFrequency: "daily", priority: 0.7,
  }));
  const serviceRoutes: MetadataRoute.Sitemap = catalog.sellers.flatMap((seller) => seller.listings
    // Match the discovery surface: revoked listings are visible on seller
    // history pages but are not advertised as destinations.
    .filter((listing) => listing.status === "active")
    .map((listing) => ({
    url: `${base}/service/${encodeURIComponent(seller.primaryClaim)}/${encodeURIComponent(listing.listingId)}/${listing.version}`,
    lastModified: new Date(listing.catalogObservedAt), changeFrequency: "daily" as const, priority: 0.8,
  })));
  return [...staticRoutes, ...serviceRoutes, ...sellerRoutes];
}
