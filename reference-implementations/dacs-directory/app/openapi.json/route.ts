import { NextRequest } from "next/server";
import { openApiDocument } from "@/src/catalog/contracts";
import { catalogJson } from "@/src/catalog/http";

export async function GET(req: NextRequest) {
  return catalogJson(req, openApiDocument(req.nextUrl.origin), { cacheControl: "public, max-age=300, stale-while-revalidate=3600" });
}
