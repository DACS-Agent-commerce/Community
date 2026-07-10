#!/usr/bin/env bash
# Vendors + builds the dacs-sdk (not yet on npm) and installs the app.
set -euo pipefail
cd "$(dirname "$0")/.."
SDK_REV="44d8ff2a07df8c951b94619d20b957b4bb5ce140"

# Railway's GitHub integration can check out this repository, but it does not
# pass its credentials through to nested private-repository clones. Supply a
# narrowly scoped, read-only token as DACS_SDK_GITHUB_TOKEN for those builds.
# The credential is passed through Git's environment-based configuration so it
# is never written to the checkout or embedded in the remote URL.
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

if [ -d vendor/dacs-sdk/dist ] && [ ! -d vendor/dacs-sdk/.git ]; then
  echo "using packaged dacs-sdk build"
else
  if [ ! -d vendor/dacs-sdk ]; then
    mkdir -p vendor
    git_with_sdk_auth clone --filter=blob:none https://github.com/DACS-Agent-commerce/dacs-sdk.git vendor/dacs-sdk
  fi
  (cd vendor/dacs-sdk && git_with_sdk_auth fetch --depth 1 origin "$SDK_REV" && git checkout --detach "$SDK_REV")
  (cd vendor/dacs-sdk && npm install --no-audit --no-fund && npm run build)
fi
if [ "${DACS_SKIP_APP_INSTALL:-0}" != "1" ]; then
  npm install --no-audit --no-fund
fi
# Seed the (gitignored, runtime-mutated) registrations file from the example
# so a fresh clone has demo data without the file churning in git.
if [ ! -f data/registrations.json ] && [ -f data/registrations.example.json ]; then
  cp data/registrations.example.json data/registrations.json
fi
echo "setup complete — npm run index (seed/refresh catalog), then npm run dev"
