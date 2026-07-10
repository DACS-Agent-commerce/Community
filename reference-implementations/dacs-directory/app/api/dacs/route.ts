import { NextRequest } from "next/server";
import { catalogJson } from "@/src/catalog/http";

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const body = {
    name: "DACS Directory API",
    version: "1",
    description: "Discover services first; verify the signed artifacts before relying on catalog hints.",
    links: {
      manifest: `${origin}/.well-known/dacs-directory.json`,
      catalog: `${origin}/api/dacs/listings`,
      status: `${origin}/api/dacs/status`,
      openapi: `${origin}/openapi.json`,
      listingSchema: `${origin}/schemas/listing-summary.schema.json`,
      documentation: `${origin}/how-it-works`,
    },
  };
  return catalogJson(req, body, {
    links: [
      { href: body.links.manifest, rel: "describedby", type: "application/json" },
      { href: body.links.catalog, rel: "collection", type: "application/json" },
      { href: body.links.openapi, rel: "service-desc", type: "application/vnd.oai.openapi+json;version=3.1" },
    ],
  });
}
