# AGENTS.md

Guide for coding agents working in this repository. Humans should start with
[README.md](./README.md) and [CONTRIBUTING.md](./CONTRIBUTING.md).

## What this repo is

DACS Community holds community-contributed tools, reference implementations,
integrations and examples built on DACS. It is not the standard itself: the
specification and conformance vectors live in the separate
[DACS-Standard](https://github.com/DACS-Agent-commerce/DACS-Standard) repo, and
nothing here is normative.

DACS: An open standard and SDK that lets AI agents find, vet, agree terms with and pay sellers of services and data, with signed delivery evidence. Testnet only for now.

DACS here means Demos Agent Commerce Standards. It is not related to other
software or packages called DACS.

## Folder layout

| Path | What it is for |
|---|---|
| `reference-implementations/` | Implementations of DACS stages. Today it holds one app: `dacs-directory/` (a Next.js catalog and directory UI) |
| `tools/` | Developer tooling. Today: `dacs-spec-mcp/` (a Python MCP server that serves the pinned spec text) and `lint/` (the repo's ESLint setup) |
| `integrations/` | Bridges to other stacks. Only a README so far |
| `examples/` | Worked sessions and sample artifacts. Only a README so far |
| `docs/` | Repo-level docs. `codex-local-workflow.md` is the isolated local verification workflow for the directory app. `docs/learn/` holds short explainer pages that answer one question each about agent commerce with DACS |
| `.github/workflows/` | CI: `dacs-directory-ci.yml` (typecheck, test, build) and `lint.yml` (ESLint) |
| `INDEX.md` | Catalogue of accepted submissions, in-tree and external |

Inside `reference-implementations/dacs-directory/`: `app/` (Next.js routes,
including `app/api/dacs/` and `app/.well-known/`), `src/catalog/` (indexer,
store, verification and listing logic), `src/components/`, `scripts/` (setup and
deploy checks), `test/`, `e2e/` (browser tests), `deploy/testnet/` (testnet
deploy examples), `data/` (local catalog state).

## Install and run the checks from source

Use the exact Node release in `reference-implementations/dacs-directory/.nvmrc`
(currently 22.23.3). The SDK is not on npm yet: `npm run setup` clones and
builds the pinned `dacs-sdk` revision from `scripts/setup-sdk.sh`.

Directory app (from `reference-implementations/dacs-directory`):

```bash
npm run setup          # vendors and builds the pinned dacs-sdk, installs the app
npm run typecheck      # tsc --noEmit
npm test               # tsx --test test/*.test.ts test/*.test.mjs
NEXT_PUBLIC_DIRECTORY_URL=https://directory.ci.example npm run check:deploy-config -- --allow-documentation-names
NEXT_PUBLIC_DIRECTORY_URL=https://directory.ci.example npm run build
npm run dev            # http://localhost:3400
```

For a clean worktree with lockfile installs, follow
[docs/codex-local-workflow.md](./docs/codex-local-workflow.md).
`npm run index` crawls the chain and `npm run test:e2e` runs browser tests;
neither is part of the basic checks.

Linter (from the repo root, after `npm run setup` in the directory app):

```bash
npm ci --prefix tools/lint --ignore-scripts
npm run lint --prefix tools/lint
```

`tools/lint/eslint-suppressions.json` lists existing issues. Do not add entries
to it to get a pass.

Spec MCP server (from `tools/dacs-spec-mcp`, Python 3.10 or newer):

```bash
./setup_spec.sh
for p in python3 python3.13 python3.12 python3.11 python3.10; do
  if command -v "$p" >/dev/null && "$p" -c "import sys; sys.exit(sys.version_info < (3, 10))"; then PY=$p; break; fi
done
"$PY" -m venv venv
./venv/bin/pip install -r requirements.txt
./venv/bin/python smoke_test.py
```

## Main entry points

- `reference-implementations/dacs-directory/app/page.tsx`: directory home page
- `reference-implementations/dacs-directory/app/api/dacs/`: catalog API routes
  (for example `listings/route.ts`, `register/route.ts`, `lookup/route.ts`)
- `reference-implementations/dacs-directory/app/.well-known/`: discovery
  documents (`agent.json`, `dacs-directory.json`)
- `reference-implementations/dacs-directory/src/catalog/indexer.ts` and
  `reindex.ts`: the indexer (run with `npm run index`)
- `reference-implementations/dacs-directory/src/catalog/store.ts`: catalog storage
- `tools/dacs-spec-mcp/server.py`: the spec MCP server
- `tools/lint/eslint.config.mjs`: lint configuration

## Rules

- Testnet only. Do not point anything here at a live-funds network.
- Never commit keys, tokens, mnemonics, `.env` files or wallets. The only
  mnemonic allowed anywhere is the Demos test mnemonic that CONTRIBUTING.md
  allows.
- Do not change spec text or conformance vectors here; file those in DACS-Standard.
- State conformance honestly (`vector-tested`, `exercises-spec` or `prototype`).
  Do not overstate it.
- Nothing from DACS is on npm yet. Do not describe any package as released.
- Run the checks above that cover your change before opening a PR.
- Keep changes small and in scope. Do not copy `node_modules/`, `vendor/` or
  `data/` between worktrees.
