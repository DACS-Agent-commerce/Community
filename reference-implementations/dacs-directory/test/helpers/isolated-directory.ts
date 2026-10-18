// Import before catalog modules: their SQLite connection opens at module load.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-current-indexer-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));
