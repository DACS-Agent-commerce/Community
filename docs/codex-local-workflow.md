# Safe local verification for the DACS Directory

This workflow verifies the Directory application from a fresh Community
worktree without borrowing mutable state or credentials from another checkout.
It uses the Node version and SDK revision already pinned by the repository.

## Keep the worktree isolated

- Use Node 22, as required by
  `reference-implementations/dacs-directory/.nvmrc` and `package.json`.
- Do not copy `.env` files, tokens, wallets, seeds, `data/`, `node_modules/`, or
  `vendor/` from another worktree.
- Keep development catalog state under this worktree's
  `reference-implementations/dacs-directory/data/` directory. Verification uses
  a separate disposable directory, as shown below.
- Do not run the indexer or live/paid browser tests as part of local static and
  unit verification. They are separate, networked activities.

## Install the pinned dependencies

From the Community repository root, use your normally initialized version
manager to select an already-installed Node 22 (for example `nvm use 22`) and
confirm that `node --version` prints `v22.x`. Then set paths from the current
worktree rather than a fixed checkout location:

```bash
repo_root=$(git rev-parse --show-toplevel)
app_dir="$repo_root/reference-implementations/dacs-directory"
cd "$app_dir"

export DACS_DIRECTORY_DATA="$app_dir/data"
export NEXT_TELEMETRY_DISABLED=1
unset RUN_LIVE_PAID_E2E LIVE_BUTLER_ORIGIN
```

Read the exact SDK commit from the committed setup script, then create or
reuse a clean vendor checkout in this worktree and install both dependency trees
from their lockfiles. The block runs in a subshell with `set -euo pipefail`, so
pasting it into an interactive shell stops at the first failure instead of
building whatever the SDK checkout happens to contain. It builds only after
`HEAD` is verified to be the pinned commit:

```bash
(
  set -euo pipefail
  die() { echo "stopped: $*" >&2; exit 1; }

  # Resolve all Git paths from the selected checkout, not the caller's shell.
  unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_SHALLOW_FILE
  unset GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES

  sdk_rev=$(sed -n 's/^SDK_REV="\([0-9a-f]\{40\}\)"$/\1/p' scripts/setup-sdk.sh)
  [ "${#sdk_rev}" -eq 40 ] || die "no 40-hex SDK_REV found in scripts/setup-sdk.sh"

  app_root=$(pwd -P)
  sdk="$app_root/vendor/dacs-sdk"
  # Reject redirected paths before cloning or changing any checkout.
  [ ! -L "$app_root/vendor" ] || die "vendor must not be a symlink"
  [ ! -L "$sdk" ] || die "$sdk must not be a symlink"
  if [ ! -e "$sdk" ]; then
    mkdir -p vendor
    git clone --filter=blob:none https://github.com/DACS-Agent-commerce/dacs-sdk.git "$sdk"
  fi

  # Require a standalone checkout here, not a linked worktree or shared store.
  [ "$(cd "$sdk" && pwd -P)" = "$sdk" ] || die "$sdk resolves outside this worktree"
  [ -d "$sdk/.git" ] && [ ! -L "$sdk/.git" ] \
    || die "$sdk needs a private .git directory; linked worktrees are not supported"
  objects="$sdk/.git/objects"
  [ -d "$objects" ] && [ ! -L "$objects" ] \
    && [ "$(cd "$objects" && pwd -P)" = "$objects" ] \
    && [ "$(git -C "$sdk" rev-parse --path-format=absolute --git-path objects)" = "$objects" ] \
    || die "$sdk needs its own local .git/objects directory"
  object_links=$(find "$objects" -type l -print -quit) || die "cannot inspect $objects"
  [ -z "$object_links" ] || die "$sdk has redirected object-store entries; use a standalone clone"
  for alternate in alternates http-alternates; do
    [ ! -e "$objects/info/$alternate" ] && [ ! -L "$objects/info/$alternate" ] \
      || die "$sdk shares an object store; use a standalone clone"
  done
  [ "$(git -C "$sdk" rev-parse --show-toplevel)" = "$sdk" ] \
    || die "$sdk is not a Git checkout of its own; inspect it, do not overwrite it"
  [ -z "$(git -C "$sdk" status --porcelain)" ] \
    || die "$sdk has local changes; inspect them, do not overwrite them"

  git -C "$sdk" fetch --depth 1 origin "$sdk_rev"
  git -C "$sdk" checkout --detach "$sdk_rev"
  [ "$(git -C "$sdk" rev-parse HEAD)" = "$sdk_rev" ] || die "$sdk is not at $sdk_rev"

  (cd "$sdk" && npm ci --no-audit --no-fund && npm run build)
  npm ci --no-audit --no-fund
)
```

Rerunning the block on a clean checkout is safe: it re-pins the checkout and
reinstalls. If it prints `stopped: ...` or any command fails, fix that before
continuing; do not run the checks below on a partial install. Access to the SDK
repository may require your normal GitHub authentication; do not put a token in
a remote URL or committed file.

The existing clone's `origin` is used for fetching, but its checked-out `HEAD`
must still match the exact SDK commit pinned by this repository.

## Run deterministic checks

These are the same check commands as the Directory CI's typecheck, test,
origin-validation, and production-build steps. CI's `npm run setup` and the
installation above both use `npm ci` for the SDK and app. Use the same
placeholder origins as the `env:` block of
`.github/workflows/dacs-directory-ci.yml` (today
`NEXT_PUBLIC_DIRECTORY_URL` and `NEXT_PUBLIC_BUTLER_ORIGIN`; drop any variable
the workflow no longer sets):

```bash
(
  set -euo pipefail
  verification_data=$(mktemp -d "${TMPDIR:-/tmp}/dacs-directory-checks.XXXXXX")
  trap 'rm -rf -- "$verification_data"' EXIT
  export DACS_DIRECTORY_DATA="$verification_data"

  npm run typecheck
  npm test
  NEXT_PUBLIC_DIRECTORY_URL=https://directory.ci.local \
    NEXT_PUBLIC_BUTLER_ORIGIN=https://agents.ci.local \
    npm run check:deploy-config
  NEXT_PUBLIC_DIRECTORY_URL=https://directory.ci.local \
    NEXT_PUBLIC_BUTLER_ORIGIN=https://agents.ci.local \
    npm run build
)
```

These commands do not require the indexer, a wallet, paid commerce, or a shared
runtime data directory. Store imports and build-time migrations use the temporary
catalog, which is removed on success or failure. The subshell leaves the
development data path selected above intact. Browser checks are separate from
this deterministic verification set.

If interactive development is needed, first seed the worktree-local catalog the
way `npm run setup` does. The seed is only read when the SQLite catalog is first
created, so copy it before any development command that imports the store,
including the first `next dev`:

```bash
[ -f data/registrations.json ] || cp data/registrations.example.json data/registrations.json
```

Then bind only to loopback and let the OS choose a currently free port:

```bash
./node_modules/.bin/next dev --hostname 127.0.0.1 --port 0
```

Use the URL printed by Next.js. Do not attach to a port already used by another
worktree.
