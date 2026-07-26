import { upsertCounterpartyEvidenceSeller } from "../src/catalog/counterpartyEvidence.js";
import { loadCatalog, loadFixtureSeeds, saveCatalog, saveFixtureSeeds, withDataLock } from "../src/catalog/store.js";

const now = Date.now();
await withDataLock("reindex", () => {
  const seeds = loadFixtureSeeds();
  saveFixtureSeeds([...seeds, "counterparty-evidence"]);

  const catalog = loadCatalog();
  saveCatalog({
    catalogVersion: "1",
    generatedAt: now,
    sellers: upsertCounterpartyEvidenceSeller(catalog.sellers, now),
  });
});

console.log("enabled and seeded Counterparty Evidence Desk into DACS_DIRECTORY_DATA");
