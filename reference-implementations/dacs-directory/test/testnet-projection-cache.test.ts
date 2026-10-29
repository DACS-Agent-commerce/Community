import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { noRateCatalog } from "./fixtures/no-rate-catalog.js";
import * as counter from "./fixtures/catalog-projection-counter.js";

const data = mkdtempSync(join(tmpdir(), "dacs-projection-cache-"));
process.env.DACS_DIRECTORY_DATA = data;
// Count projections while keeping the real store dependencies and database.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith("/src/catalog/store.ts")) {
      if (specifier === "./testnetMetrics.js") return { url: new URL("./fixtures/catalog-projection-counter.ts", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { loadCatalog, loadStoredCatalog, saveCatalog } = await import("../src/catalog/store.js");
hooks.deregister();
test.after(() => rmSync(data, { recursive: true, force: true }));

test("public reads reuse the projection and callers cannot poison cached results", () => {
  saveCatalog(noRateCatalog());
  const before = counter.projectionCalls;
  const first = loadCatalog();
  first.sellers[0].displayName = "caller mutation";
  const second = loadCatalog();
  assert.equal(counter.projectionCalls - before, 1);
  assert.equal(second.sellers[0].displayName, "Observed History Service");
  assert.equal(second.sellers[0].deals[0].ratings?.[0].value, null);
  assert.equal(loadStoredCatalog().sellers[0].deals[0].ratings?.[0].value, 5);
});

test("same-timestamp local and external saves invalidate the public projection", () => {
  const fixture = noRateCatalog();
  saveCatalog(fixture);
  loadCatalog();
  fixture.sellers[0].displayName = "local revision";
  saveCatalog(fixture);
  assert.equal(loadCatalog().sellers[0].displayName, "local revision");
  const other = new Database(join(data, "directory.sqlite"));
  try {
    fixture.sellers[0].displayName = "external revision";
    other.prepare("UPDATE kv_state SET value_json = ? WHERE key = 'catalog'").run(JSON.stringify(fixture));
    assert.equal(loadCatalog().sellers[0].displayName, "external revision");
  } finally { other.close(); }
});
