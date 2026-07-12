/**
 * Reindex CLI — re-verifies every registration against chain state and
 * rewrites the catalog cache. Run on a timer (systemd/cron) in deployment.
 *
 *   DEMOS_RPC=… npm run index
 *
 * CCI resolution uses the timestamp-bound authenticated fetch path in gcr.ts.
 * Keeping the CLI on this narrow protocol surface avoids installing the Demos
 * client's unrelated multichain/bridge dependency tree.
 */
import { reindexAll } from "./reindexCore.js";
import { withDataLock } from "./store.js";

withDataLock("reindex", () => reindexAll())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("reindex failed:", e?.message ?? e);
    process.exit(1);
  });
