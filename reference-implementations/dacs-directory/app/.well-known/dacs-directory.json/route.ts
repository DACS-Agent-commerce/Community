import { NextRequest } from "next/server";
import { directoryManifest } from "@/src/catalog/contracts";
import { catalogJson } from "@/src/catalog/http";

export async function GET(req: NextRequest) {
  return catalogJson(req, directoryManifest(req.nextUrl.origin), {
    cacheControl: "public, max-age=300, stale-while-revalidate=3600",
    links: [{ href: `${req.nextUrl.origin}/openapi.json`, rel: "service-desc", type: "application/vnd.oai.openapi+json;version=3.1" }],
  });
}
