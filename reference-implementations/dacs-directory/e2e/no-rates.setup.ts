import { rmSync } from "node:fs";
import { noRateCatalog } from "../test/fixtures/no-rate-catalog.js";

export default async function setup() {
  const dataDirectory = process.env.DACS_NO_RATE_TEST_DATA;
  if (!dataDirectory) throw new Error("No-rate browser data directory is required");
  process.env.DACS_DIRECTORY_DATA = dataDirectory;
  const { saveCatalog } = await import("../src/catalog/store.js");
  saveCatalog(noRateCatalog());
  return () => rmSync(dataDirectory, { recursive: true, force: true });
}
