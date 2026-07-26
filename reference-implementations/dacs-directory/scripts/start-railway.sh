#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

DATA_DIR="${DACS_DIRECTORY_DATA:-${RAILWAY_VOLUME_MOUNT_PATH:-$(pwd)/data}}"
export DACS_DIRECTORY_DATA="$DATA_DIR"
mkdir -p "$DATA_DIR"

if [ ! -f "$DATA_DIR/registrations.json" ] && [ -f data/registrations.example.json ]; then
  cp data/registrations.example.json "$DATA_DIR/registrations.json"
fi

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
