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
import { DataLeaseTimeoutError, withDataLock } from "./store.js";

let callbackStarted = false;
withDataLock("reindex", () => {
  callbackStarted = true;
  return reindexAll();
})
  .then(() => process.exit(0))
  .catch((e) => {
    if (!callbackStarted && e instanceof DataLeaseTimeoutError && e.leaseName === "reindex") {
      console.log("reindex skipped: another reindex holds the data lease");
      process.exit(0);
    }
    console.error("reindex failed:", e?.message ?? e);
    process.exit(1);
  });
