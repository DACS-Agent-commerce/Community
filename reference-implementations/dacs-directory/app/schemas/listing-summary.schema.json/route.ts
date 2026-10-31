import { NextRequest } from "next/server";
import { listingSummarySchema } from "@/src/catalog/contracts";
import { catalogJson } from "@/src/catalog/http";

export async function GET(req: NextRequest) {
  // The schema URL is unversioned, so it must not be cached as immutable: a
  // contract change has to reach clients within minutes (ETag revalidates).
  return catalogJson(req, listingSummarySchema, { cacheControl: "public, max-age=300, must-revalidate" });
}
