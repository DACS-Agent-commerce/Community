import { NextRequest } from "next/server";
import { directoryManifest } from "@/src/catalog/contracts";
import { catalogJson } from "@/src/catalog/http";
import { requestBaseUrl } from "@/src/catalog/publicUrl";

export async function GET(req: NextRequest) {
  const origin = requestBaseUrl(req);
  return catalogJson(req, directoryManifest(origin), {
    cacheControl: "public, max-age=300, stale-while-revalidate=3600",
    links: [{ href: `${origin}/openapi.json`, rel: "service-desc", type: "application/vnd.oai.openapi+json;version=3.1" }],
  });
}
