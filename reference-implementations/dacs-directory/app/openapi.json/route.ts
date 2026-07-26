import { NextRequest } from "next/server";
import { openApiDocument } from "@/src/catalog/contracts";
import { catalogJson } from "@/src/catalog/http";
import { requestBaseUrl } from "@/src/catalog/publicUrl";

export async function GET(req: NextRequest) {
  return catalogJson(req, openApiDocument(requestBaseUrl(req)), { cacheControl: "public, max-age=300, stale-while-revalidate=3600" });
}
