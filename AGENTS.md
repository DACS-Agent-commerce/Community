# DACS Community agent guide

This repository contains non-normative community implementations and tooling for the
DACS agent-commerce standard. Normative specifications and conformance vectors live in
the separate DACS-Standard repository; do not silently redefine them here.

## Repository map

- `reference-implementations/dacs-directory/`: Next.js directory, catalog API,
  chain indexer, browser verification, tests, and the main active application.
- `tools/`: developer and specification tooling.
- `integrations/`: bridges to external protocols and payment rails.
- `examples/`: worked examples and sample artifacts.
- `INDEX.md`: accepted community submissions and their declared DACS surface.

Read the closest nested `AGENTS.md` before editing a project. For the directory app,
also consult its `README.md` and the relevant Next.js 16 documentation under
`node_modules/next/dist/docs/` before changing framework APIs.

## Directory workflow

Use Node.js 22.12 or newer. The root `.nvmrc` selects Node 22. Run commands from
`reference-implementations/dacs-directory/`:

```bash
npm run setup
npm run dev -- --port 3400
npm run index:watch
npm run parity
npm test
npm run typecheck
npm run build
npm run test:e2e
```

In Conductor, use its assigned `$CONDUCTOR_PORT`; never introduce a fixed port into a
shared run script. Worktrees must not share mutable catalog, registration, or scan-state
files. Keep secrets and generated runtime data out of Git.

## SDK and indexer invariants

- The reviewed SDK revision is pinned in `scripts/setup-sdk.sh`. When it changes,
  review every affected listing, catalog, verification, artifact-addressing, and
  identity surface, then update `sdk-parity.json` deliberately.
- Registration is a discovery pointer, not trusted listing data. Resolve artifacts
  from chain state and validate them before publication.
- Verification, authority, provenance, scan-depth, and chain-state uncertainty must
  fail closed. Do not turn an indeterminate result into a success or reputation signal.
- Preserve durable cursor semantics and atomic catalog publication. A capped or failed
  scan must not advance past unprocessed transactions.
- Keep the browser/server trust boundary explicit: browser cryptography does not by
  itself prove chain inclusion when RPC bytes pass through the server.
- Never commit admin tokens, wallet seeds, mnemonics, `.indexer-seed`, or mutable files
  from `data/` that are listed in `.gitignore`.

## Definition of done

- Run tests proportionate to the change and report any checks that could not run.
- For SDK, catalog, verification, or indexer changes, run `npm run parity`, `npm test`,
  and `npm run typecheck` at minimum.
- For runtime or UI changes, also run `npm run build`; run the relevant Playwright tests
  for user-visible flows.
- Add or update regression tests when behavior changes. Update documentation when an
  endpoint, environment variable, trust claim, setup step, or known limitation changes.
- Keep changes scoped and preserve unrelated work already present in the worktree.
