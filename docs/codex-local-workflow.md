# Safe local verification for the DACS Directory

This workflow verifies the Directory application from a fresh Community
worktree without borrowing mutable state or credentials from another checkout.
It uses the Node version and SDK revision already pinned by the repository.

## Keep the worktree isolated

- Use the exact Node release in `reference-implementations/dacs-directory/.nvmrc`,
  as CI does. `package.json` engines only states the supported range (Node 22).
- Do not copy `.env` files, tokens, wallets, seeds, `data/`, `node_modules/`, or
  `vendor/` from another worktree.
- Keep any mutable catalog state under this worktree's
  `reference-implementations/dacs-directory/data/` directory.
- Do not run the indexer or browser tests as part of local static and unit
  verification. The indexer is a separate, networked activity, and the browser
  tests need their own setup.

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

  sdk_rev=$(sed -n 's/^SDK_REV="\([0-9a-f]\{40\}\)"$/\1/p' scripts/setup-sdk.sh)
  [ "${#sdk_rev}" -eq 40 ] || die "no 40-hex SDK_REV found in scripts/setup-sdk.sh"

  sdk=vendor/dacs-sdk
  if [ ! -e "$sdk" ]; then
    mkdir -p vendor
    git clone --filter=blob:none https://github.com/DACS-Agent-commerce/dacs-sdk.git "$sdk"
  fi

  # An existing path must be its own Git checkout with no local changes.
  [ "$(git -C "$sdk" rev-parse --show-toplevel)" = "$(cd "$sdk" && pwd -P)" ] \
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

## Run deterministic checks

These are the same check commands as the Directory CI's typecheck, test,
origin-validation, and production-build steps. The install differs: CI runs
`npm run setup` (`npm install`), while this workflow uses `npm ci`. Use the same
placeholder origin as the `env:` block of
`.github/workflows/dacs-directory-ci.yml` (today only
`NEXT_PUBLIC_DIRECTORY_URL`). That origin is a reserved documentation name, so,
as in CI, the origin check runs with `--allow-documentation-names`. It still
rejects `.local` and other non-public hosts, so do not substitute a local origin:

```bash
npm run typecheck
npm test
NEXT_PUBLIC_DIRECTORY_URL=https://directory.ci.example npm run check:deploy-config -- --allow-documentation-names
NEXT_PUBLIC_DIRECTORY_URL=https://directory.ci.example npm run build
```

These commands do not require the indexer, a wallet, paid commerce, or a shared
runtime data directory. Browser checks are separate from this deterministic
verification set.

If interactive development is needed, first seed the worktree-local catalog the
way `npm run setup` does. The seed is only read when the SQLite catalog is first
created, so copy it before the first `next dev`:

```bash
[ -f data/registrations.json ] || cp data/registrations.example.json data/registrations.json
```

Then bind only to loopback and let the OS choose a currently free port:

```bash
./node_modules/.bin/next dev --hostname 127.0.0.1 --port 0
```

Use the URL printed by Next.js. Do not attach to a port already used by another
worktree.
