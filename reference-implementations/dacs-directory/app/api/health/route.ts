import { accessSync, constants, mkdirSync } from "node:fs";
import { NextResponse } from "next/server";
import { DATA_DIR_MODE } from "@/src/catalog/dataFolderMode";

export const dynamic = "force-dynamic";

export async function GET() {
  const dataDir = process.env.DACS_DIRECTORY_DATA ?? `${process.cwd()}/data`;
  try {
    mkdirSync(dataDir, { recursive: true, mode: DATA_DIR_MODE });
    accessSync(dataDir, constants.R_OK | constants.W_OK);
    // The store opens its database on import, so load it here where a failure becomes a 503.
    const { loadCatalog } = await import("@/src/catalog/store");
    const catalog = loadCatalog();
    return NextResponse.json({ ok: true, catalogGeneratedAt: catalog.generatedAt });
  } catch (error) {
    console.error("Health route failed:", error);
    return NextResponse.json({ ok: false, error: "catalog data directory is unavailable" }, { status: 503 });
  }
}
