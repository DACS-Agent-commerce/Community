import Database from "better-sqlite3";
import { join } from "node:path";

/**
 * Make every write of the catalog in `dataDirectory` fail, as a full disk or a locked database would.
 * Returns the function that allows them again.
 */
export function refuseCatalogWrites(dataDirectory: string): () => void {
  const blocker = new Database(join(dataDirectory, "directory.sqlite"));
  blocker.exec("CREATE TRIGGER refuse_catalog_write BEFORE UPDATE ON kv_state WHEN new.key = 'catalog' " +
    "BEGIN SELECT RAISE(ABORT, 'the catalog write failed'); END");
  return () => {
    blocker.exec("DROP TRIGGER refuse_catalog_write");
    blocker.close();
  };
}
