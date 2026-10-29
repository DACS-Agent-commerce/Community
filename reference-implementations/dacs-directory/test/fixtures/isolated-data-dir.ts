import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// store.ts fixes its DATA_DIR when it is first imported. A test file whose
// static imports reach the store imports this module first, so the catalog
// opens in a fresh directory instead of the checkout's data/, where an earlier
// run's rows (a rejected revocation candidate, say) change later results.
export const isolatedDataDir = mkdtempSync(join(tmpdir(), "dacs-directory-test-"));
process.env.DACS_DIRECTORY_DATA = isolatedDataDir;
process.on("exit", () => rmSync(isolatedDataDir, { recursive: true, force: true }));
