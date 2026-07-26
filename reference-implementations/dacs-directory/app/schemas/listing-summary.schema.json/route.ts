import { NextRequest } from "next/server";
import { listingSummarySchema } from "@/src/catalog/contracts";
import { catalogJson } from "@/src/catalog/http";

export async function GET(req: NextRequest) {
  return catalogJson(req, listingSummarySchema, { cacheControl: "public, max-age=86400, immutable" });
}
