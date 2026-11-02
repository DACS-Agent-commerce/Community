import type { Catalog, ScanProgress } from "./types.js";
/** Always use the persisted catalog snapshot, never independently read mutable scanner state. */
export function catalogScanProgress(catalog: Catalog): ScanProgress {
  return catalog.scanProgress ?? { cursor: null, tip: null, lag: null,
    cursorAdvancedAt: null, lastSuccessfulFullScanAt: null, fromTx: null };
}
