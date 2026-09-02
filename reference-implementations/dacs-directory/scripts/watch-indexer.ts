import { runLiveIndexer } from "../src/catalog/liveIndexer.js";

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => controller.abort());
}

runLiveIndexer({ signal: controller.signal }).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
