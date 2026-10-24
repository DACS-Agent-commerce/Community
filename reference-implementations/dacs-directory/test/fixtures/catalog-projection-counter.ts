import { projectTestnetCatalog as project } from "../../src/catalog/testnetMetrics.js";
import type { Catalog } from "../../src/catalog/types.js";

export let projectionCalls = 0;
export function projectTestnetCatalog(catalog: Catalog): Catalog {
  projectionCalls++;
  return project(catalog);
}
