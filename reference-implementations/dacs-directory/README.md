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
| Seller publication | DACS-1 §6.3.4 | `/register` builds and wallet-signs a current Listing, creates its StorageProgram with the live next-nonce/empty-salt mapping from SDK #70, persists non-secret recovery coordinates before broadcast, and independently verifies native address, owner, program name, tuple, identity, signature and content hash before catalog registration |
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
`scripts/setup-sdk.sh`; no globally installed SDK is required. For a fresh, isolated
worktree with lockfile installs and loopback-only development, see
[safe local verification](../../docs/codex-local-workflow.md). Tests and static checks
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
| `DACS_SDK_GITHUB_TOKEN` | No | Fine-grained, read-only token for cloning the pinned SDK from a private mirror during the build; the upstream SDK repository is public |
| `DACS_DIRECTORY_DATA` | No | Writable directory for the SQLite repository and legacy JSON migration inputs |
| `DACS_SCAN_MAX_TXS` | No | Maximum transactions scanned per pass; defaults to `100000` and fails closed if insufficient |
| `DACS_SCAN_FINALITY_DEPTH` | No | Newest transaction count held back before indexing; defaults to `2` |
| `DACS_SCAN_REPLAY_DEPTH` | No | Finalized transaction overlap replayed on every pass; defaults to `2` |
| `DACS_INDEX_INTERVAL_SECONDS` | No | Seconds between production reindex passes; defaults to `900` |
| `DACS_CURSOR_STALL_SECONDS` | No | Cursor-stall alert threshold; defaults to twice the valid index interval (minimum `300`, default `1800`, maximum `86400`) |
| `DACS_REACHABILITY_MAX_PROBES` | No | Maximum due listing surfaces probed per reindex; defaults to `20` (bounded to `1..100`) |
| `DACS_REACHABILITY_CONCURRENCY` | No | Concurrent pinned HTTPS reachability probes; defaults to `5` (bounded to `1..10`) |
| `DACS_RAIL_SNAPSHOTS` | For positive payment verdicts | Operator-authenticated PA-1 registry snapshots (`registryVersion`, `rails` with exact `railId`, `railVersion`, `phaseHandler`, `railType`, `asset`, `network`, `parameters`, `availability`); absent/unknown versions remain indeterminate. Provision only after authenticating the registry index and definitions. Only live native DEM definitions have a settlement adapter. |
| `DACS_RECIPE_POLICIES` | For identity tier policy | JSON array of version-pinned DACS-2 recipe policies (`scheme`, `recipeVersion`, `methods`, `defaultMaxAgeSec`, `availability`, `trustedResultSigners`); absent/invalid policy leaves claims unverified for tiers and included vet results indeterminate for session admission |
| `DACS_RECIPE_SNAPSHOTS` | For session vetting | Operator-authenticated JSON array of historical `{registryVersion, recipes}` snapshots; `recipes` uses the same policy shape. Session pins select exact snapshots; unversioned requirements select the latest recipe in that snapshot. Missing snapshots remain indeterminate. |
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
`STORAGE_RPC_UNAVAILABLE`, `STORAGE_INVALID_RESPONSE`, and `ARTIFACT_REJECTED`. Missing and non-public
locators are terminal until a later chain replay observes them again; transient node
and response failures retain bounded retries. `ARTIFACT_REJECTED` means the content was
read but fails the artifact policy (oversized, a DACS-named program without object data,
or no canonical JSON form). It has its own retry class: it is never dead-lettered, it is
retried with backoff while at most 1,000 rejected locators are active, and the
longest-waiting one takes the next free slot. `STORAGE_NOT_FOUND` is operational
diagnostic evidence only: under the current Demos mapping it is never authoritative
DACS-5 absence evidence and cannot satisfy BB-8.

## Discovery — three channels

1. **Registration** (`/register` UI or `POST /api/dacs/register`): bounded pointer sets,
   plus self-authenticating BundleBinding carriage, all independently verified. Third
   parties may submit a new candidate, but only the owner key can replace an existing
   registration.
2. **Chain scanning** (passive): the reindex pass walks the node's transaction history
   (`nodeCall getTransactions`, plain fetch), spots storage-program writes, classifies
   current-profile DACS artifacts by their signed content, and attributes a deal to its
   seller through the agreement its buyer bundle references by locator and content hash.
   Program names are never resolution keys, except on the legacy SDK compatibility path
   (`dacs5:bundle:<jobId>`, `dacs3:agreement:<jobId>`). Agents nobody registered appear as
   "discovered on-chain". Depth: `DACS_SCAN_MAX_TXS` (default 100000); a pass that
   hits the cap fails rather than advancing the cursor and silently skipping history.
   Revocation markers are recognised by their signed content, never by program name.
   Every candidate locator is queued once per listing hash; each pass fully verifies
   at most 16 per listing — markers that already passed RB-4 first, then those
   anchored by the listing owner, then arrival order. The queue itself has no cap.
   While any candidate is unread or not yet examined the RB-4 check is incomplete
   (`indeterminate`, RB-5), so the listing is withheld from the catalog rather than
   published `active`. Once a marker verifies, the listing stays `revoked` with its
   binding even if the marker later cannot be read (RB-3).
   BB-4-valid BundleBindings are also classified and kept, all of them: DACS-1 §6.3.6
   requires a carrying catalog to serve every such record whoever signed it, and
   `GET /api/dacs/bundles/{jobId}` pages through the full set (`limit`, `cursor`). The
   Directory's own BB-6 resolution works through at most 32 per signer of each job and
   role; another signer's bindings never use that budget. Overflow is sticky and makes
   that signer's side `indeterminate`, never absent. There is no total across signers,
   so stored bindings, and the work to re-verify them each pass, grow with the number of
   bindings published for one job.
3. **Evidence graph and federation**: current bundle copies are reached only after
   deriving the role-specific logical address and resolving a signed BundleBinding.
   The optional DACS-1 well-known bundle-binding index is hash-bound and SSRF-bounded.
   Resolved bundles recursively validate listings,
   agreements, settlement evidence and amendment chains, composite/VerifyResult vet
   records, and ratings. The signed listing fixes every phase kind and index; completed
   sessions include every listed settle phase, with one evidence record per invocation.
   A successful payment states its amount, rail-specific finality and observation time,
   and transactions. Payment phase indices are recovered independently from the SR-2
   program name and checked against the evidence hash and the listing rail. Settlements
   are keyed per SB-1 (`demos:{txHash}`, `evm:{chainId}:{txHash}:{logIndex}`,
   `solana:{cluster}:{signature}:{instructionIndex}`); a reference that cannot be keyed
   leaves the deal listed but uncounted. One catalog-wide SB-2 ledger admits claims before
   computing any seller or category totals. Legacy SDK artifacts remain on an
   explicitly-labelled compatibility path.

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
  Before any StorageProgram broadcast, the browser persists the public signed artifact,
  exact native/write coordinates and unsigned registration. A reload re-verifies that
  same anchor and refreshes only the catalog-pointer signature; it never creates another
  listing version or re-sends a chain transaction automatically.
- **Scanner depth is bounded** per pass. Increase `DACS_SCAN_MAX_TXS` if a backfill or
  unusually large interval exceeds the configured cap.
- **DACS-2 recipe governance is deployment policy.** `verifiedBy` evidence cannot
  elevate a tier unless its exact recipe version/method/availability/max-age policy is
  present in `DACS_RECIPE_POLICIES`; missing policy fails closed. Required session vetting
  selects the exact `DACS_RECIPE_SNAPSHOTS` registry pin: the scheme/version must be live, permit the result method,
  and trust its authenticated signer, including results with an explicit expiry. Every
  included result, even an optional one, needs a valid live policy. Missing, invalid and
  non-live recipes remain indeterminate until the catalog can disclose each result's availability.
- **Authority proofs need a method-specific deployment verifier.** `EvidenceGraphDeps.verifyAttestation`
  and the identity-tier verification argument must authenticate the original format's hash scope,
  required signer, validator roster/epoch and proof. The result signer's signature does not replace
  this check. No production authority adapter is installed, so these proofs remain indeterminate
  for sessions and do not elevate identity tiers.
- **Canonical input uses Unicode scalar values.** Server and browser reject lone UTF-16 surrogates
  in string values and property names before canonical hashing. This publisher's pinned serializer
  supports integer negotiation percentages; fractional percentages receive HTTP 400. This is a
  narrower publication profile than the Standard's fractional-percentage inputs.
- **Discovery keeps withdrawals.** Machine catalog and well-known listing indexes retain revoked
  versions with `revocation`; active skills and sitemap links use executable offers. Crawled
  withdrawals enter the marker verification queue; unreadable proofs withhold active admission.
  Cached `revocationBinding` summaries migrate to the normative wire field on read.
- **A2A cards require an actual service endpoint.** The well-known generator accepts `a2aEndpoint`
  and `a2aTransport` (`JSONRPC`, `GRPC`, or `HTTP+JSON`) together. The endpoint may be hosted
  separately from the discovery domain. Without them it emits a DACS discovery descriptor at
  `agent.json`, with no A2A transport declaration or `agent-card.json` file. Endpoint configuration
  is the publisher's declaration; generation does not probe its protocol implementation.
- **Storage delivery is verified from readable cleartext and node access metadata.**
  Successful `deliver-storage-program` evidence must name a payload anchor and cleartext hash.
  The hash covers the complete canonical payload, including any `signature` or `signatures`
  fields. The payload must match that hash and the job's program name; `buyer-only` requires a
  restricted ACL naming the agreement-bound buyer. The pinned node denies anonymous reads of
  restricted programs, so buyer-only delivery is indeterminate for this anonymous catalog. The
  readable restricted-ACL tests describe a hypothetical node metadata contract. Unreadable payloads, encrypted payloads
  and external pointers remain indeterminate and contribute no completion or volume.
- **BundleBinding key resolution currently implements the directory's canonical Demos
  agent profile.** BB-4 accepts self-describing `did:demos:agent:<64hex>` claims. A
  binding signed through another ClaimReference/key-resolution method is not carried or
  used until that resolver is configured; it fails closed to `indeterminate` rather
  than being relabelled as verified.
- **DACS-3 §8.5.2 checks 5 and 6 need the commitment's anchored `committedAt`**, and a
  bundle does not reference the CommitmentRecord. A session whose listing sets
  `terms.deadlineSecAfterCommit` or `validity.notAfter` is therefore `indeterminate` and
  never counted; `SPEC_PIN` lists this and the other recorded deviations.
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

Every catalog save applies one settlement ledger across all sellers, including scheduled
indexing and immediate refreshes. A deal's `reputationEligible` records its verified evidence
eligibility; `settlementRejected` records its current catalog admission separately. Rejected
deals contribute no metrics or listing hints, and later saves reconsider them if the winning
claim disappears or changes. Run a full reindex when upgrading an existing catalog so its
cached evidence eligibility is refreshed.

**Upstream source contracts.** The Directory records these source revisions:

- **DACS Standard**: `SPEC_PIN` records the revision this Directory implements (v0.4,
  `4bb9e48`), the conformance vector files vendored under `test/fixtures/dacs-standard/`
  with their hashes, and the recorded deviations. `test/standard-vectors.test.ts` checks
  the hashes and runs each set through an adapter onto the Directory's own decisions. The
  `did:demos:agent` primary-claim profile is the one deliberate addition; it comes from
  DACS-Standard #296 on `next` at `725fa78`, whose fixture is vendored too.
- **dacs-sdk**: `SDK_REV` in `scripts/setup-sdk.sh`. It supplies canonical hashing,
  Ed25519, CCI parsing and the verifier for the labelled legacy SDK path.
- **Demos node**: the read contract is pinned to `kynesyslabs/node` `ac8f45f`.
  `GET /storage-program/<address>` answers `{success: false, errorCode}` with 404
  `NOT_FOUND`, 403 `PERMISSION_DENIED` or 400 `INVALID_REQUEST` (an address without the
  `stor-` prefix), or `{success, owner, programName, data, ...}`; a program holds at most
  1 MiB (`STORAGE_PROGRAM_MAX_SIZE_BYTES`). Only the node's 404 `NOT_FOUND` is a
  definitive absence; a 403 `PERMISSION_DENIED` or any other 4xx, such as a proxy's
  or a wrong route's, leaves a revocation check incomplete and a scan read retryable.
  `test/chain-storage.test.ts` pins each classification. This source pin does not
  attest the revision running at a remote RPC. The configured live service remains
  unpinned unless its operator supplies a verifiable deployment revision.

**Node deployment contract.** At `ac8f45f` the exact-name program search used by the
producer resume lookup exists only as the read-authenticated `gcr_routine
searchStoragePrograms`; a deployed node may also answer it as a `nodeCall` (node2 did on
2026-10-15). The Directory asks the `nodeCall` first and falls back to the `gcr_routine`
only on the pinned revision's literal "Unknown message" answer, so either deployment
resolves. `npm run check:node -- <exact program name>` is a read-only probe (no
transactions) that reports the storage not-found answer and both search paths, and fails
when they disagree; its output is dated runtime evidence, not a pin. Run it when the
`DEMOS_RPC` deployment changes.

## License

MIT. This in-tree submission is covered by the Community repository's root
[`LICENSE`](../../LICENSE).

Current publishers use the registry IDs `demos-native:DEM` and `x402:default`, paired with
`pay-dem` and `pay-x402` phase kinds. Historical current-profile listings signed with phase
names as rail IDs remain readable as evidence, but are excluded from public discovery; publish
a new signed listing version to make those offers executable.

Native DEM success requires public transaction and block reads confirming inclusion, the payer
and payee, and the exact agreed amount (1 DEM = 10^9 OS). The stored RPC amount is OS,
carried as a safe integer or an exact string; the send payload must contain a canonical OS
string. Historical numeric DEM payloads remain indeterminate pending a historical fork adapter.
All other current payment rails and paid SDK legacy sessions remain indeterminate until their
authoritative settlement adapters are available. They contribute no completion or volume.
Historical listings remain available on explicitly archival seller and service pages; the
well-known index, skills, seller API and sitemap advertise executable offers only.

Historical Vet admission also requires an authenticated challenge resolver. The graph checks the
verifier-issued nonce against its job, party, issuance window, authenticated first consumption
time (`consumedAt`) and `consumedByPresentationHash`, `sha256Hex(canonicalize(identity))` of the complete
first attempted IdentityBundle including `presentation` and its signatures, even when that attempt
failed. The signed bundle scope hash omits `presentation` and cannot identify an attempt. The signed
`presentedAt` timestamp is informational. This deployment does not install that resolver, so sessions
requiring Vet remain indeterminate for completion and volume. Listing publication uses its signed self-binding.
Attested-payload and entitlement deliveries likewise remain indeterminate until authoritative
attestation and grant adapters are installed. Storage delivery verifies payload bytes and ACLs.

Executable offers discovered through a hosted well-known index require source provenance.
Use a seller publisher signature, or configure `DACS_WITHDRAWAL_SOURCE_PINS` as a
server-side JSON object mapping normalized HTTPS origins to canonical seller DIDs
(for example, `{"https://agent.example":"did:demos:agent:<64 lowercase hex>"}`).
Verify that seller/domain relationship independently before adding a pin. Public
domain submissions and listing endpoints do not create pins. An unsigned, unpinned
index can carry independently verified tombstones for known listings, but cannot
introduce executable offers. A pinned unsigned index retains incomplete withdrawal
checks until a completed check from that same source or a verified revocation.

For publisher signatures,
The well-known file export returns `withdrawalSigning.message`: sign those exact UTF-8
bytes with the seller's ed25519 key and place the unpadded base64url signature in
`dacs.listings.publisherSignature` in `agent.json` (and the identical A2A alias, when
present). Keep `listings.json` byte-exact. The signing message binds the normalized
HTTPS domain and SHA-256 hash of that index; generate a new signature whenever either
changes. The registration page displays this message and the completion instructions.
Before queuing a carried marker, the crawler independently verifies the listing's
publisher, chain owner, content hash, ID and version. Unsigned Standard indexes can
discover independently verified seller-signed tombstones. A listing's `seller.publicEndpoint`
is a self-claim and does not authorize unresolved hints. Discovery deduplicates anchors
and bindings and spends at most 32 node reads per domain per pass, with a persisted
cursor for continuation. Authenticated bindings remain seller-scoped until the indexer
verifies the listing's publisher, owner and tuple using its own listing read. An authenticated
index with an incomplete withdrawal entry withholds that offer until a later
complete authenticated check or a verified revocation resolves it. Failed later
crawls retain incomplete checks; verified tombstones remain revoked. Upgrades retain
affected seller/hash holds, including checks with no queued marker. Legacy sources
without recorded provenance require a signature or operator pin before reconciliation;
chain replay alone cannot release those holds. Ambiguous legacy candidates hold only
their listing hashes until chain replay completes; unrelated source failures do not
delay replay completion. Authenticated recrawls must retain each source's index
timestamp and hash ordering, including after migration. A stored timestamp that is
incorrectly ahead of the publisher's current index requires explicit operator
revalidation of that source; an older index cannot silently replace it.
