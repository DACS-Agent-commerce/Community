import { accessSync, constants, mkdirSync } from "node:fs";
import { NextResponse } from "next/server";
import { loadCatalog } from "@/src/catalog/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const dataDir = process.env.DACS_DIRECTORY_DATA ?? `${process.cwd()}/data`;
  try {
    mkdirSync(dataDir, { recursive: true });
    accessSync(dataDir, constants.R_OK | constants.W_OK);
    const catalog = loadCatalog();
    return NextResponse.json({ ok: true, catalogGeneratedAt: catalog.generatedAt });
  } catch {
    return NextResponse.json({ ok: false, error: "catalog data directory is unavailable" }, { status: 503 });
  }
}
