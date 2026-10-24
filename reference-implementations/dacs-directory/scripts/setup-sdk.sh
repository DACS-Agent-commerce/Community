#!/usr/bin/env bash
# Vendors + builds the dacs-sdk (not yet on npm) and installs the app.
set -euo pipefail
cd "$(dirname "$0")/.."
SDK_REV="3904d704fb540e6e1d7dd502a0be29f20569c92d"

# The SDK repository is public, so the clone needs no credentials. When a
# narrowly scoped, read-only token is set as DACS_SDK_GITHUB_TOKEN, it only
# authenticates that clone. The credential is passed through Git's
# environment-based configuration so it is never written to the checkout or
# embedded in the remote URL.
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

# The DACS Standard revision the pinned SDK declares (package.json
# dacs.standardRevision); the Directory implements the profile in SPEC_PIN.
STANDARD_REV="d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20"
SDK_PATCH_SHA256="11f1594a3d1b4c60effdb24690d844890a23f1283a42107e728ecfa68bfa955e"
# The markers sit beside dist, not in it: the digest covers every file in dist.
SDK_REV_MARKER="vendor/dacs-sdk/.dacs-sdk-revision"
SDK_MANIFEST="vendor/dacs-sdk/.dacs-sdk-manifest"
# scripts/sdk-dist-digest.mjs over the dist that SDK_REV builds to (`npm ci`
# then `npm run build` and sdk-compat-output.mjs on the pinned Node release).
# A packaged or freshly built
# dist is accepted only with exactly these bytes.
SDK_DIST_SHA256="28fadba6574e34840f42c9436ca98a91ff25fc0ab6b2606b538be6023400ef72"

require_standard_revision() {
  local declared
  declared="$(node -e 'process.stdout.write(String(require(process.argv[1]).dacs?.standardRevision ?? ""))' "$PWD/vendor/dacs-sdk/package.json")"
  if [ "$declared" != "$STANDARD_REV" ]; then
    echo "dacs-sdk declares Standard revision '${declared}', expected ${STANDARD_REV}" >&2
    exit 1
  fi
}

require_pinned_dist() {
  local digest
  digest="$(node scripts/sdk-dist-digest.mjs vendor/dacs-sdk/dist "$@")"
  if [ "$digest" != "$SDK_DIST_SHA256" ]; then
    echo "vendor/dacs-sdk/dist has digest ${digest}, not the pinned build ${SDK_DIST_SHA256}" >&2
    exit 1
  fi
}

if [ -d vendor/dacs-sdk/dist ] && [ ! -d vendor/dacs-sdk/.git ]; then
  # A packaged build is accepted only when its bytes are the pinned build of
  # the pinned commit; the marker alone is not evidence.
  if [ "$(cat "$SDK_REV_MARKER" 2>/dev/null)" != "$SDK_REV" ]; then
    echo "packaged dacs-sdk build is not marked as built from ${SDK_REV}; refusing it" >&2
    exit 1
  fi
  require_standard_revision
  require_pinned_dist
  echo "using packaged dacs-sdk build of ${SDK_REV}"
else
  if [ ! -d vendor/dacs-sdk ]; then
    mkdir -p vendor
    git_with_sdk_auth clone --filter=blob:none https://github.com/DACS-Agent-commerce/dacs-sdk.git vendor/dacs-sdk
  fi
  (cd vendor/dacs-sdk && git_with_sdk_auth fetch --depth 1 origin "$SDK_REV" && git_with_sdk_auth checkout --detach "$SDK_REV")
  if [ "$(git -C vendor/dacs-sdk rev-parse HEAD)" != "$SDK_REV" ] ||
    [ -n "$(git -C vendor/dacs-sdk status --porcelain --untracked-files=no)" ]; then
    echo "vendor/dacs-sdk is not a clean checkout of ${SDK_REV}" >&2
    exit 1
  fi
  require_standard_revision
  # Apply the explicit compatibility patch only to the clean pinned source.
  if [ "$(sha256sum scripts/dacs-sdk-compat.patch | cut -d ' ' -f 1)" != "$SDK_PATCH_SHA256" ]; then
    echo "dacs-sdk compatibility patch digest mismatch" >&2
    exit 1
  fi
  # tsc never deletes stale output, so build into an empty dist; the old
  # marker and manifest describe the old dist and go with it.
  rm -rf vendor/dacs-sdk/dist "$SDK_REV_MARKER" "$SDK_MANIFEST"
  # The SDK lockfile at SDK_REV is enforced, so its demosdk and crypto dependencies are the pinned ones.
  (
    cd vendor/dacs-sdk
    git apply --check ../../scripts/dacs-sdk-compat.patch
    git apply ../../scripts/dacs-sdk-compat.patch
    trap 'git apply --reverse ../../scripts/dacs-sdk-compat.patch' EXIT
    npm ci --no-audit --no-fund && npm run build
    node ../../scripts/sdk-compat-output.mjs .
  )
  require_pinned_dist --manifest "$SDK_MANIFEST"
  printf '%s' "$SDK_REV" > "$SDK_REV_MARKER"
fi
if [ "${DACS_SKIP_APP_INSTALL:-0}" != "1" ]; then
  npm ci --no-audit --no-fund
fi
# Seed the (gitignored, runtime-mutated) registrations file from the example
# so a fresh clone has demo data without the file churning in git.
if [ ! -f data/registrations.json ] && [ -f data/registrations.example.json ]; then
  cp data/registrations.example.json data/registrations.json
fi
echo "setup complete — npm run index (seed/refresh catalog), then npm run dev"
