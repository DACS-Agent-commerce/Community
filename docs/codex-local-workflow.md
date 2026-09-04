# Safe local verification for the DACS Directory

This workflow verifies the Directory application from a fresh Community
worktree without borrowing mutable state or credentials from another checkout.
It uses the Node version and SDK revision already pinned by the repository.

## Keep the worktree isolated

- Use Node 22, as required by
  `reference-implementations/dacs-directory/.nvmrc` and `package.json`.
- Do not copy `.env` files, tokens, wallets, seeds, `data/`, `node_modules/`, or
  `vendor/` from another worktree.
- Keep any mutable catalog state under this worktree's
  `reference-implementations/dacs-directory/data/` directory.
- Do not run the indexer or live/paid browser tests as part of local static and
  unit verification. They are separate, networked activities.

## Install the pinned dependencies

From the Community repository root, use your normally initialized version
manager to select an already-installed Node 22, then set paths from the current
worktree rather than a fixed checkout location:

```bash
nvm use 22

repo_root=$(git rev-parse --show-toplevel)
app_dir="$repo_root/reference-implementations/dacs-directory"
cd "$app_dir"

export DACS_DIRECTORY_DATA="$app_dir/data"
export NEXT_TELEMETRY_DISABLED=1
unset RUN_LIVE_PAID_E2E LIVE_BUTLER_ORIGIN
```

Read the exact SDK commit from the committed setup script, then create a clean
vendor checkout in this worktree and install both dependency trees from their
lockfiles:

```bash
sdk_rev=$(sed -n 's/^SDK_REV="\([0-9a-f]\{40\}\)"$/\1/p' scripts/setup-sdk.sh)
test "${#sdk_rev}" -eq 40

mkdir -p vendor
git clone --filter=blob:none https://github.com/DACS-Agent-commerce/dacs-sdk.git vendor/dacs-sdk
git -C vendor/dacs-sdk fetch --depth 1 origin "$sdk_rev"
git -C vendor/dacs-sdk checkout --detach "$sdk_rev"

(cd vendor/dacs-sdk && npm ci --no-audit --no-fund && npm run build)
npm ci --no-audit --no-fund
```

If `vendor/dacs-sdk` already exists, first confirm that it is a Git checkout,
has no local changes, and is at the pinned commit. Preserve unexpected content
instead of overwriting it. Access to the SDK repository may require your normal
GitHub authentication; do not put a token in a remote URL or committed file.

## Run deterministic checks

The local equivalent of the Directory CI's static, unit, and production-build
checks is:

```bash
npm run typecheck
npm test
NEXT_PUBLIC_DIRECTORY_URL=https://directory.ci.local \
  NEXT_PUBLIC_BUTLER_ORIGIN=https://agents.ci.local \
  npm run check:deploy-config
NEXT_PUBLIC_DIRECTORY_URL=https://directory.ci.local \
  NEXT_PUBLIC_BUTLER_ORIGIN=https://agents.ci.local \
  npm run build
```

These commands do not require the indexer, a wallet, paid commerce, or a shared
runtime data directory. Browser checks are separate from this deterministic
verification set.

If interactive development is needed, bind only to loopback and let the OS
choose a currently free port:

```bash
./node_modules/.bin/next dev --hostname 127.0.0.1 --port 0
```

Use the URL printed by Next.js. Do not attach to a port already used by another
worktree.
