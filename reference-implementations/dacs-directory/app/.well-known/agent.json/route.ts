import { NextRequest } from "next/server";
import { catalogJson } from "@/src/catalog/http";
import { requestBaseUrl } from "@/src/catalog/publicUrl";

export async function GET(req: NextRequest) {
  const origin = requestBaseUrl(req);
  return catalogJson(req, {
    name: "DACS Directory",
    description: "Search signed agent-service listings and retrieve their verification material.",
    url: origin,
    capabilities: ["service-discovery", "seller-lookup", "catalog-freshness", "deal-verification-material"],
    dacs: {
      dacsVersion: "1",
      directoryManifest: `${origin}/.well-known/dacs-directory.json`,
      catalog: `${origin}/api/dacs/listings`,
      openapi: `${origin}/openapi.json`,
    },
  }, { cacheControl: "public, max-age=300, stale-while-revalidate=3600" });
}
