#!/usr/bin/env bash
# Vendors + builds the dacs-sdk (not yet on npm) and installs the app.
set -euo pipefail
cd "$(dirname "$0")/.."
# Reviewed SDK main after canonical artifact-address conformance (#214).
# Keep this exact: catalog projections record the SDK profile they validated.
SDK_REV="50a8c0489c04572f96015176e5f357f000cf230b"

# CI/deploy checkouts do not automatically pass credentials to a sibling SDK
# repository. Use an optional narrowly scoped read token without persisting it
# in the clone URL or local Git configuration.
git_with_sdk_auth() {
  if [ -z "${DACS_SDK_GITHUB_TOKEN:-}" ]; then
    command git "$@"
    return
  fi
  local basic_auth
  basic_auth="$(printf 'x-access-token:%s' "$DACS_SDK_GITHUB_TOKEN" | base64 | tr -d '\r\n')"
  GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0="http.https://github.com/.extraHeader" \
    GIT_CONFIG_VALUE_0="Authorization: Basic ${basic_auth}" \
    command git "$@"
}

if [ ! -d vendor/dacs-sdk ]; then
  mkdir -p vendor
  git_with_sdk_auth clone --filter=blob:none https://github.com/DACS-Agent-commerce/dacs-sdk.git vendor/dacs-sdk
fi
(cd vendor/dacs-sdk && git_with_sdk_auth fetch --depth 1 origin "$SDK_REV" && git_with_sdk_auth checkout --detach "$SDK_REV")
(cd vendor/dacs-sdk && npm install --no-audit --no-fund && npm run build)
npm install --no-audit --no-fund
# Seed the (gitignored, runtime-mutated) registrations file from the example
# so a fresh clone has demo data without the file churning in git.
if [ ! -f data/registrations.json ] && [ -f data/registrations.example.json ]; then
  cp data/registrations.example.json data/registrations.json
fi
echo "setup complete — npm run index (seed/refresh catalog), then npm run dev"
