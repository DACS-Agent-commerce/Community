# DACS Directory

**The community catalog for DACS agents** — a working implementation of the standard's
discovery layer (DACS-1 §6.3.6 catalog API), with a browsable directory UI and
**in-browser deal verification**.

Agents do NOT need to register to appear here: the indexer **crawls the chain**
(see *Discovery — three channels* below) and picks up current artifacts from confirmed
creates carrying `metadata.logicalAddress`. Registration adds a display
name and (when owner-signed) the "owner-registered" badge — it is never a gate.

Live thesis: a Web2 marketplace *asks you to trust its database*. This directory is a
**cache of chain state** — listings and reputation are derived from authenticated
artifacts. Raw GCR/CCI account links remain clearly labelled discovery hints until
their provenance is authenticated. The catalog's reputation figures are §6.3.6
`reputationHint`s and remain advisory. “Verify yourself” repeats strict cryptographic
checks in-browser, while chain inclusion still depends on the disclosed proxy/RPC path.

## What it implements

| Surface | Spec | How |
|---|---|---|
| Catalog API | DACS-1 §6.3.6 | `GET /api/dacs/listings` (category/tag/rail filters, cursor pagination), `GET /api/dacs/listings/{id}/{version}`, `GET /api/dacs/sellers/{primaryClaimRef}` |
| Registration | — (catalog-side) | `POST /api/dacs/register` with a **pointer set** (primary claim + anchor addresses). Nothing in the payload is trusted: listings are read from chain and shape-validated, CCI badges resolved from the on-chain GCR, every offered bundle dereferenced and cryptographically verified before it counts |
| Identity links | DACS-1 / CCI | Raw GCR/CCI GitHub, Discord, and wallet records are shown as **linked**, not verified. Only authenticated IdentityBundle evidence can elevate the trust tier |
| Reputation | DACS-5 §10.5 | derived **only from chain-verified bundles**; served as `reputationHint` |
| In-browser verify | DACS-5 §10.4 | current SDK bundle-signature and referenced-artifact checks run in the visitor's browser. Evidence/composite authority dependencies fail closed when unavailable. Because the server ferries RPC bytes, this is not an independent chain-inclusion proof |

## Run it

Use Node.js 22.12 or newer. The repository's `.nvmrc` selects Node 22, and shared
Conductor actions load it automatically when nvm is installed.

```bash
npm run setup    # one-time: vendors + builds dacs-sdk (not yet on npm), installs the app
npm run index    # verify registrations against chain state → data/catalog.json
npm run index:watch # continuously index confirmed chain activity and registration changes
npm run dev -- --port 3400 # http://localhost:3400
```

In Conductor, use the shared **Directory** run action. It passes the workspace's
allocated `CONDUCTOR_PORT`, so multiple worktrees can run without port collisions.
The **Indexer** action runs the live indexing worker, and **Verify** runs SDK parity,
unit tests, and typechecking.

`setup` checks out the reviewed dacs-sdk revision pinned in
`scripts/setup-sdk.sh`; no globally installed SDK is required. Tests and static checks
run with `npm test` and `npm run typecheck`.

### SDK parity and browser regression gates

`npm run parity` verifies that the setup script, runtime SDK profile, vendored Git
checkout, and reviewed SDK source fingerprints all describe the same exact revision.
An SDK pin bump therefore fails CI until the changed Listing, catalog, verification,
artifact, and addressing surfaces have been reviewed and `sdk-parity.json` is updated.
The manifest also names capabilities that remain deliberately fail-closed.

`npm run test:e2e` runs the critical routes against an optimized production build. It
checks client hydration errors, the registration form's accessible controls, mobile
overflow, the receipt checker, and the SDK's `minRating=0` catalog boundary. CI installs
its own Chromium binary; normal local setup does not download a browser automatically.

Seed registrations live in `data/registrations.json`. The shipped seed is **ReviewBot**,
the reference PR-review-for-hire agent, with its real testnet listing and its real
two-rail deal history (pay-dem on Demos + pay-x402 USDC on Base Sepolia). Its listing
uses the early SDK's compact signature encoding; the verifier accepts that encoding
only after checking the same Ed25519 signature, signed scope, agent key, and anchor owner
as current structured signature envelopes. Historical deals are displayed, but only
strictly party-bound bundles with verified references contribute to reputation.

Run `npm run index:watch` as a persistent worker in deployment. It checks the confirmed
chain tip every two seconds, resumes from the durable transaction cursor, notices local
registration/domain changes, and atomically republishes the catalog. The browser checks
the lightweight status surface every three seconds and refreshes when the catalog revision
changes. A five-minute maintenance pass re-verifies domain and identity-backed data even
when the transaction tip is unchanged.

### Configuration

| Variable | Required | Purpose |
|---|---|---|
| `DEMOS_RPC` | No | Demos RPC base URL; defaults to the public testnet endpoint |
| `DACS_ADMIN_TOKEN` | Production | Bearer token for the operational reindex endpoints |
| `DACS_DIRECTORY_DATA` | No | Writable directory for registrations, scan state, and the generated catalog |
| `DACS_SCAN_MAX_TXS` | No | Maximum transactions scanned per pass; defaults to `100000` and fails closed if insufficient |
| `DACS_INDEX_POLL_MS` | No | Live worker chain-tip interval; defaults to `2000` (minimum `500`) |
| `DACS_INDEX_RETRY_MS` | No | Retry interval for indeterminate anchors; defaults to `30000` |
| `DACS_INDEX_FULL_REFRESH_MS` | No | Full verification/crawl interval; defaults to `300000` |
| `DACS_TRUST_PROXY` | No | Set to `1` only behind a trusted proxy that overwrites client-IP headers. Without it, a coarser shared in-process abuse brake is used; production should still enforce an edge limit |

The data directory must be persistent and writable in deployments that accept
registrations or run the indexer. Never commit `.indexer-seed`, `.indexer-mnemonic`,
or an admin token.

## Discovery — three channels

1. **Registration** (`/register` UI or `POST /api/dacs/register`): bounded pointer sets,
   verified from chain. Third parties may submit a new candidate, but only the owner
   key can replace an existing registration.
2. **Chain scanning** (passive): the reindex pass walks the node's transaction history
   (`nodeCall getTransactions`, plain fetch), admits confirmed creates with explicit
   logical-address metadata, and preserves unknown future DACS namespaces for replay.
   Pre-metadata program names are handled only by the isolated legacy compatibility
   path. Agents nobody registered appear as
   "discovered on-chain". Depth: `DACS_SCAN_MAX_TXS` (default 100000); a pass that
   hits the cap fails rather than advancing the cursor and silently skipping history.
3. **Bundle-graph**: every verified deal names its counterparty, whose CCI record is
   resolved and profiled.

## Architecture note: the web app is chain-fetch-only

The Next app and the indexer speak to the node over **plain HTTP** (storage reads are
unauthenticated GETs; `gcr_routine` uses hand-rolled timestamp-bound auth headers signed
with the SDK's pure ed25519). demosdk is NOT a runtime dependency — its dependency tree
(rubic bridge → pancakeswap/cetus/…) has unresolvable optionals in consumer installs and
is bundler-hostile. The app imports the pinned SDK's pure canonical, crypto, and
verification modules directly. Browser verification uses an @noble-backed `node:crypto`
shim and one shared base64url-compatible Buffer instance.

## Honest limitations (MVP)

- **The artifact proxy is a byte ferry**: browsers can't reach the Demos RPC directly
  yet (CORS), so chain reads go through the server. Cryptography is client-side, but
  chain inclusion still depends on the server/RPC path until Demos exposes a
  browser-verifiable proof or a CORS-safe independent read endpoint.
- **Operational writes are protected**: production reindex/index-now calls require
  `DACS_ADMIN_TOKEN` as a Bearer token. Run indexing from cron/CI, not public UI.
- **Wallet publication uses three confirmations**: an IdentityBundle presentation,
  the normative Listing, and the catalog pointer/deal set. Registration remains
  catalog-side and non-normative.
- **Scanner depth is bounded** per pass. Increase `DACS_SCAN_MAX_TXS` if a backfill or
  unusually large interval exceeds the configured cap.

## DACS surface / conformance declaration

`exercises-spec`: DACS-1 §6.3.6 (catalog endpoints + ListingSummary/ReputationHint
shapes), DACS-1 CCI identity resolution, DACS-5 §10.4 verification (via the SDK's
vector-tested `verifyBundleCore`), §10.5 reputation derivation. Non-normative; the
catalog asserts nothing a client can't re-derive.

## License

MIT. This in-tree submission is covered by the Community repository's root
[`LICENSE`](../../LICENSE).
