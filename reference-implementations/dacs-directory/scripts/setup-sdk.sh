#!/usr/bin/env bash
# Vendors + builds the dacs-sdk (not yet on npm) and installs the app.
set -euo pipefail
cd "$(dirname "$0")/.."
SDK_REV="44d8ff2a07df8c951b94619d20b957b4bb5ce140"
if [ ! -d vendor/dacs-sdk ]; then
  mkdir -p vendor
  git clone --filter=blob:none https://github.com/DACS-Agent-commerce/dacs-sdk.git vendor/dacs-sdk
fi
(cd vendor/dacs-sdk && git fetch --depth 1 origin "$SDK_REV" && git checkout --detach "$SDK_REV")
(cd vendor/dacs-sdk && npm install --no-audit --no-fund && npm run build)
npm install --no-audit --no-fund
echo "setup complete — npm run index (seed/refresh catalog), then npm run dev"
