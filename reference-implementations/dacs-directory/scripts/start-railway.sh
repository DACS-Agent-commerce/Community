#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Refuse to serve on a Node release other than .nvmrc's.
node scripts/check-node-runtime.mjs

DATA_DIR="${DACS_DIRECTORY_DATA:-${RAILWAY_VOLUME_MOUNT_PATH:-$(pwd)/data}}"
export DACS_DIRECTORY_DATA="$DATA_DIR"
mkdir -p "$DATA_DIR"

if [ ! -f "$DATA_DIR/registrations.json" ] && [ -f data/registrations.example.json ]; then
  cp data/registrations.example.json "$DATA_DIR/registrations.json"
fi

# Say at boot, not only in later refusals, when the node is not the pinned
# deployment. Not fatal: the web app still serves the last verified catalog.
npm run check:node-deployment || echo "[indexer] the configured Demos node is not the pinned deployment; publication/inclusion observations require reviewed DEMOS_CHAIN_IDENTITY and DEMOS_NODE_BUILDS; catalog refresh requires the chain pin and continues with a warning for build drift alone"

reindex_forever() {
  while true; do
    echo "[indexer] refreshing the DACS catalog"
    npm run index || echo "[indexer] refresh failed; the last verified catalog remains available"
    sleep "${DACS_INDEX_INTERVAL_SECONDS:-900}"
  done
}

reindex_forever &
index_pid=$!
./node_modules/.bin/next start -p "${PORT:-3400}" &
web_pid=$!

cleanup() {
  kill -TERM "$index_pid" "$web_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait "$web_pid"
status=$?
cleanup
wait "$index_pid" 2>/dev/null || true
exit "$status"
