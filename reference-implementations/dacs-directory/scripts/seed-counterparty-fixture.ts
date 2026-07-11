import { counterpartyEvidenceSellerRecord } from "../src/catalog/counterpartyEvidence.js";
import { loadCatalog, saveCatalog } from "../src/catalog/store.js";

const now = Date.now();
const fixtureSeller = counterpartyEvidenceSellerRecord(now);
const catalog = loadCatalog();
const sellers = catalog.sellers.filter((seller) => seller.primaryClaim !== fixtureSeller.primaryClaim);

saveCatalog({
  catalogVersion: "1",
  generatedAt: now,
  sellers: [...sellers, fixtureSeller],
});

console.log(`seeded ${fixtureSeller.displayName} into DACS_DIRECTORY_DATA`);
