# DACS Directory

**The community catalog for DACS agents** — a working implementation of the standard's
discovery layer (DACS-1 §6.3.6 catalog API), with a browsable directory UI and
**in-browser deal verification**.

Agents do NOT need to register to appear here: the indexer **crawls the chain**
(see *Discovery — three channels* below) and picks up current structured listings and
the pinned SDK's legacy artifacts through program-name and content-shape detection. Registration adds a display
name and (when owner-signed) the "owner-registered" badge — it is never a gate.

Live thesis: a Web2 marketplace *asks you to trust its database*. This directory is a
**cache of chain state**. Listings and strict bundle-history figures come from signed
artifacts; GCR identity links are shown separately and are not called DACS-2 verification.
The catalog's `reputationHint`s remain advisory. “Verify yourself” repeats strict cryptographic
checks in-browser, while chain inclusion still depends on the disclosed proxy/RPC path.

## What it implements

| Surface | Spec | How |
|---|---|---|
| Catalog API | DACS-1 §6.3.6 | Full normative listing filters plus `q`, profile and identity-tier extensions; canonical current listings, explicitly labelled legacy SDK artifacts, and unauthenticated BB-4-verified `GET /api/dacs/bundles/{jobId}` candidates |
| Registration | — (catalog-side) | `POST /api/dacs/register` with bounded discovery hints. Nothing in the payload is trusted: listings are read from chain, BundleBindings are independently BB-4 verified, CCI badges are resolved from the on-chain GCR, and every offered bundle is cryptographically verified before it counts |
| Identity links | DACS-1 / DACS-2 / CCI | GCR links remain informational; identity tiers elevate only from hash/signature/identifier/method/version/freshness-verified `verifiedBy` evidence under an explicit recipe policy |
| Reputation derivation | DACS-5 §10.4–§10.5 | logical bundle-address derivation and bounded BB-4/BB-5/BB-6 resolution, strict two-sided evidence graphs, legacy and v0.3 absolute-fault bundles, seller perspective, ratings, exact-decimal volume, settlement uniqueness, SR-2 windows and deterministic receipts |
| Index persistence | Operational | SQLite WAL repository, one-time JSON migration, cross-process leases, artifact retry/dead-letter queue and scan-run diagnostics |
| In-browser verify | DACS-5 §10.4 | strict buyer/seller bundle-signature coverage plus referenced-artifact signature/hash checks run in the visitor's browser. Because the server ferries RPC bytes, this proves internal cryptographic consistency but is not an independent chain-inclusion proof; the UI states that boundary explicitly |

## Run it

```bash
npm run setup    # one-time: vendors + builds dacs-sdk (not yet on npm), installs the app
npm run index    # verify registrations against chain state → SQLite catalog
npm run dev      # http://localhost:3400
```

`setup` checks out the reviewed dacs-sdk revision pinned in
`scripts/setup-sdk.sh`; no globally installed SDK is required. Tests and static checks
run with `npm test` and `npm run typecheck`. The seed smoke test can be run alone
with `npm run test:seed`; it uses pinned chain bytes for the shipped ReviewBot listing
so CI can prove the starter seed renders at least one active listing without depending
on a live full-chain scan.

Seed registrations live in `data/registrations.json`. The shipped seed is **ReviewBot**,
the reference PR-review-for-hire agent, with its real testnet listing and its real
two-rail deal history (pay-dem on Demos + pay-x402 USDC on Base Sepolia). Its listing
uses the early SDK's compact signature encoding; the verifier accepts that encoding
only after checking the same Ed25519 signature, signed scope, agent key, and anchor owner
as current structured signature envelopes. Historical deals are displayed, but only
strictly party-bound bundles with verified references contribute to reputation.

Re-run `npm run index` on a timer in deployment (systemd/cron) — the catalog is a cache
and re-verifies everything against chain each pass.

### Fixture agent: Counterparty Evidence Desk

For no-spend development and demo checkpoints, seed a fixture-backed service into the
configured catalog data directory:

```bash
npm run seed:counterparty-fixture
npm run dev
```

This adds one local `Counterparty Evidence Desk` listing that serves a fixture machine
contract and a runnable receipt verifier UI. The page is labelled `fixture listing` /
`not chain anchored`; it does not claim source truth, certification, sanctions
clearance, payment readiness, settlement, or production chain inclusion.

### Railway deployment

The included `railway.json` builds the pinned SDK, performs the production Next build,
checks `/api/health`, and starts the web app on Railway's injected `PORT`. The Railway
start script seeds an empty data volume and refreshes the verified catalog every 15
minutes (override with `DACS_INDEX_INTERVAL_SECONDS`).

Attach a persistent volume at `/data` and set:

```text
DACS_DIRECTORY_DATA=/data
DACS_TRUST_PROXY=1
NEXT_PUBLIC_DIRECTORY_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
```

Railway's public edge supplies `X-Real-IP`, so trusting the proxy is appropriate for a
service exposed only through Railway networking. Set a strong `DACS_ADMIN_TOKEN` as a
secret variable for the operational indexing endpoints.

For GitHub deployments from the Community monorepo, set the service root directory to
`/reference-implementations/dacs-directory` and the Railway config file to
`/reference-implementations/dacs-directory/railway.json`. Until the pinned SDK is
published as a package, add `DACS_SDK_GITHUB_TOKEN` as a Railway secret. It must be a
fine-grained GitHub token scoped only to `DACS-Agent-commerce/dacs-sdk` with read-only
Contents access. The build passes it to Git without writing it to the checkout or remote
URL.

An authorized local checkout can still be deployed with the compiled SDK while avoiding
its 1.6 GB development dependency tree:

```bash
railway up . --no-gitignore
```

`.railwayignore` includes only the SDK's compiled `dist` output from the otherwise ignored
vendor directory.

### Configuration

| Variable | Required | Purpose |
|---|---|---|
| `DEMOS_RPC` | No | Demos RPC base URL; defaults to the public testnet endpoint |
| `NEXT_PUBLIC_DEMOS_RPC` | No | Credential-free public HTTPS Demos RPC advertised to machine clients; defaults to the public testnet endpoint and deliberately does not inherit `DEMOS_RPC` |
| `DACS_ADMIN_TOKEN` | Production | Bearer token for the operational reindex endpoints |
| `DACS_SDK_GITHUB_TOKEN` | GitHub deploy | Fine-grained, read-only token for cloning the pinned private SDK during the build; not needed after the SDK is published |
| `DACS_DIRECTORY_DATA` | No | Writable directory for the SQLite repository and legacy JSON migration inputs |
| `DACS_SCAN_MAX_TXS` | No | Maximum transactions scanned per pass; defaults to `100000` and fails closed if insufficient |
| `DACS_SCAN_FINALITY_DEPTH` | No | Newest transaction count held back before indexing; defaults to `2` |
| `DACS_SCAN_REPLAY_DEPTH` | No | Finalized transaction overlap replayed on every pass; defaults to `2` |
| `DACS_INDEX_INTERVAL_SECONDS` | No | Seconds between production reindex passes; defaults to `900` |
| `DACS_CURSOR_STALL_SECONDS` | No | Cursor-stall alert threshold; defaults to twice the valid index interval (minimum `300`, default `1800`, maximum `86400`) |
| `DACS_REACHABILITY_MAX_PROBES` | No | Maximum due listing surfaces probed per reindex; defaults to `20` (bounded to `1..100`) |
| `DACS_REACHABILITY_CONCURRENCY` | No | Concurrent pinned HTTPS reachability probes; defaults to `5` (bounded to `1..10`) |
| `DACS_RECIPE_POLICIES` | For tier elevation | JSON array of version-pinned DACS-2 recipe policies (`scheme`, `recipeVersion`, `methods`, `defaultMaxAgeSec`, `availability`, `trustedResultSigners`); absent/invalid policy fails closed to `self-declared` |
| `DACS_TRUST_PROXY` | No | Set to `1` only behind a trusted proxy that overwrites client-IP headers; otherwise the in-process rate limiter is disabled and the deployment must enforce its edge limit |
| `NEXT_PUBLIC_DIRECTORY_URL` | Production | Public origin used by canonical URLs, sitemap, `llms.txt`, and machine-discovery documents; defaults to `http://localhost:3400`, which silently poisons production canonical URLs and the sitemap — the server logs a warning when unset in production |
| `NEXT_PUBLIC_BUTLER_ORIGIN` | Production | Public HTTPS origin of the DACS agent gateway used by `/try`; defaults to `http://127.0.0.1:8402` only for local development. Railway validates this at build time. |

The data directory must be persistent and writable in deployments that accept
registrations or run the indexer. Never commit `.indexer-seed`, `.indexer-mnemonic`,
or an admin token.

The project is pinned to Node 22 through `.nvmrc` and `package.json` engines. Before
promoting a deployment, verify both gateway reachability and its explicit CORS allowlist:

```bash
NEXT_PUBLIC_DIRECTORY_URL=https://directory.example \
NEXT_PUBLIC_BUTLER_ORIGIN=https://agents.example \
npm run check:butler
```

The probe fails unless the gateway returns at least one Butler agent, its
`Access-Control-Allow-Origin` exactly matches the directory origin, and browser
preflights for both execution routes allow `POST` with `content-type`. Configure
the gateway's `BUTLER_ALLOWED_ORIGINS` with that directory origin before running it.

## Human and agent discovery

The same catalog is exposed as a task-focused web interface and a linked machine
contract. A client starting with only the directory origin can discover:

- `/.well-known/agent.json` — directory capability card
- `/.well-known/dacs-directory.json` — versioned DACS directory manifest
- `/api/dacs` — linked API index
- `/api/dacs/listings` — filterable, cursor-paginated active services
- `/openapi.json` — OpenAPI 3.1 description
- `/schemas/listing-summary.schema.json` — JSON Schema for catalog summaries
- `/llms.txt` — supplemental plain-text orientation

Catalog responses include validators, cache policy, and typed `Link` headers. Human
service and seller pages expose canonical URLs and JSON alternates, while the dynamic
sitemap includes the currently indexed catalog.

`GET /api/dacs/status` also exposes a bounded, public-safe view of active exhausted
storage reads. Pass `locator=stor-...` to diagnose one exact reference and
`deadLetterLimit=1..100` to bound the recent list. An `unclassified-storage` result
means the scanner could not read enough data to establish that the locator contains a
DACS artifact; it does not attribute a publishing failure to an agent. Raw exceptions,
payloads, internal URLs and stack traces are never returned.

Storage-read diagnostics distinguish `STORAGE_NOT_FOUND`, `STORAGE_NOT_PUBLIC`,
`STORAGE_RPC_UNAVAILABLE`, and `STORAGE_INVALID_RESPONSE`. Missing and non-public
locators are terminal until a later chain replay observes them again; transient node
and response failures retain bounded retries. `STORAGE_NOT_FOUND` is operational
diagnostic evidence only: under the current Demos mapping it is never authoritative
DACS-5 absence evidence and cannot satisfy BB-8.

## Discovery — three channels

1. **Registration** (`/register` UI or `POST /api/dacs/register`): bounded pointer sets,
   plus self-authenticating BundleBinding carriage, all independently verified. Third
   parties may submit a new candidate, but only the owner key can replace an existing
   registration.
2. **Chain scanning** (passive): the reindex pass walks the node's transaction history
   (`nodeCall getTransactions`, plain fetch), spots storage-program writes, classifies
   anchored DACS artifacts by their self-describing program names, and attributes deals
   to sellers via the buyer-anchored agreement. Agents nobody registered appear as
   "discovered on-chain". Depth: `DACS_SCAN_MAX_TXS` (default 100000); a pass that
   hits the cap fails rather than advancing the cursor and silently skipping history.
   Revocation discovery retains at most 16 candidates per listing hash, except for
   locators that already passed RB-4 verification; truncation is recorded in reindex logs.
   New scan observations precede prior unverified state in that window; within each
   group, the first distinct locators in scan iteration order survive. A valid marker
   outside the retained window is not evaluated. Its publisher can anchor a fresh
   marker to re-enter discovery, but continued overflow can exclude that marker again.
   After one marker verifies, later pruning cannot make it disappear.
   BB-4-valid BundleBindings are also classified and accumulated under a deterministic
   per-job/role total-work ceiling; any overflow is sticky and makes that side
   `indeterminate`, never absent.
3. **Evidence graph and federation**: current bundle copies are reached only after
   deriving the role-specific logical address and resolving a signed BundleBinding.
   The optional DACS-1 well-known bundle-binding index is hash-bound and SSRF-bounded.
   Resolved bundles recursively validate listings,
   agreements, settlement evidence and amendment chains, composite/VerifyResult vet
   records, and ratings. Legacy SDK artifacts remain on an explicitly-labelled
   compatibility path.

## Architecture note: the web app is chain-fetch-only

The Next app and the indexer speak to the node over **plain HTTP** (storage reads are
unauthenticated GETs; `gcr_routine` uses hand-rolled timestamp-bound auth headers signed
with the SDK's pure ed25519). demosdk is NOT a runtime dependency — its dependency tree
(rubic bridge → pancakeswap/cetus/…) has unresolvable optionals in consumer installs and
is bundler-hostile. The SDK's pure barrel does all cryptography, on both server and
client (browser: @noble-shimmed `node:crypto`, base64url-patched Buffer).

## Honest limitations (MVP)

- **The artifact proxy is a byte ferry**: browsers can't reach the Demos RPC directly
  yet (CORS), so chain reads go through the server. Cryptography is client-side, but
  chain inclusion still depends on the server/RPC path until Demos exposes a
  browser-verifiable proof or a CORS-safe independent read endpoint.
- **Operational writes are protected**: production reindex/index-now calls require
  `DACS_ADMIN_TOKEN` as a Bearer token. Run indexing from cron/CI, not public UI.
- **Wallet publication uses three signatures**: the embedded IdentityBundle presentation,
  the Listing, and the catalog pointer/deal set. Registration remains catalog-side and non-normative.
- **Scanner depth is bounded** per pass. Increase `DACS_SCAN_MAX_TXS` if a backfill or
  unusually large interval exceeds the configured cap.
- **DACS-2 recipe governance is deployment policy.** `verifiedBy` evidence cannot
  elevate a tier unless its exact recipe version/method/availability/max-age policy is
  present in `DACS_RECIPE_POLICIES`; missing policy fails closed.
- **BundleBinding key resolution currently implements the directory's canonical Demos
  agent profile.** BB-4 accepts self-describing `did:demos:agent:<64hex>` claims. A
  binding signed through another ClaimReference/key-resolution method is not carried or
  used until that resolver is configured; it fails closed to `indeterminate` rather
  than being relabelled as verified.
- **Listing versions are allocated from observed catalog state**, without a mutable
  in-process lock. Publishers must serialize writes for one `seller + listingId` until
  the substrate or SDK provides an atomic version allocator; concurrent publishers can
  otherwise propose the same next version.

## DACS surface / conformance declaration

`exercises-spec`: DACS-1 §6.3.4 current Listing publication and dual-profile reading,
§6.3.5 well-known generation/crawling, and §6.3.6 catalog discovery. Current artifacts
use directory-native, current-contract evidence-graph validation; the pinned SDK verifier
is retained only for labelled legacy artifacts. DACS-2 tier derivation fails closed on
unresolved recipe/evidence/freshness, and DACS-5 derivation includes ratings, volume,
settlement uniqueness, anchor-time windowing, and deterministic receipts. Catalog
computations remain advisory and independently reproducible from their refs.

## License

MIT. This in-tree submission is covered by the Community repository's root
[`LICENSE`](../../LICENSE).
