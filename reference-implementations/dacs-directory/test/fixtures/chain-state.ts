import Database from "better-sqlite3";
import { join } from "node:path";
import { DATA_DIR, loadCatalogChain } from "../../src/catalog/store.js";
import { SCAN_STATE_SCHEMA_VERSION } from "../../src/catalog/scanState.js";
import type { ScanState } from "../../src/catalog/types.js";

/** Seed an old on-disk state, independently of canonical production saves. */
export function seedScanState(state: ScanState): void {
  const db = new Database(join(DATA_DIR, "directory.sqlite"));
  try {
    db.transaction(() => {
      db.prepare("DELETE FROM kv_state WHERE key='catalog-chain'").run();
      db.prepare("INSERT OR REPLACE INTO kv_state(key,value_json,updated_at) VALUES ('scan-state',?,0)").run(JSON.stringify(state));
    })();
  } finally { db.close(); }
  loadCatalogChain();
}
/** Chain whose current schema replay completed, independent of scanner provenance. */
export const readyChain = () => {
  const control = loadCatalogChain();
  return control?.readySchema === SCAN_STATE_SCHEMA_VERSION ? control.evidenceChain : undefined;
};
