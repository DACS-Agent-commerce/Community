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
`/reference-implementations/dacs-directory/railway.json`. The build clones the pinned
SDK from its public repository, so it needs no credentials. To authenticate that
clone anyway, add `DACS_SDK_GITHUB_TOKEN` as a Railway secret. It must be a
fine-grained GitHub token scoped only to `DACS-Agent-commerce/dacs-sdk` with read-only
Contents access. The build passes it to Git without writing it to the checkout or remote
URL.

An authorized local checkout can still be deployed with the compiled SDK while avoiding
its 1.6 GB development dependency tree:

```bash
railway up . --no-gitignore
```

`.railwayignore` includes only the SDK's compiled `dist` output, its `package.json` and the
`.dacs-sdk-revision` marker that setup requires from the otherwise ignored vendor directory.

### Configuration

| Variable | Required | Purpose |
|---|---|---|
| `DEMOS_RPC` | No | Demos RPC base URL; defaults to the public testnet endpoint |
| `NEXT_PUBLIC_DEMOS_RPC` | No | Credential-free public HTTPS Demos RPC advertised to machine clients; defaults to the public testnet endpoint and deliberately does not inherit `DEMOS_RPC` |
| `DACS_ADMIN_TOKEN` | Production | Bearer token for the operational reindex endpoints |
| `DACS_SDK_GITHUB_TOKEN` | No | Optional fine-grained, read-only token that only authenticates the build's clone of the pinned SDK; the SDK repository is public |
| `DACS_DIRECTORY_DATA` | No | Writable directory for the SQLite repository and legacy JSON migration inputs |
| `DACS_SCAN_MAX_TXS` | No | Maximum transactions scanned per pass; defaults to `100000` and fails closed if insufficient |
| `DACS_SCAN_FINALITY_DEPTH` | No | Newest transaction count held back before indexing; defaults to `2` |
| `DACS_SCAN_REPLAY_DEPTH` | No | Finalized transaction overlap replayed on every pass; defaults to `2` |
| `DACS_INDEX_INTERVAL_SECONDS` | No | Seconds between production reindex passes; defaults to `900` |
| `DACS_CURSOR_STALL_SECONDS` | No | Cursor-stall alert threshold; defaults to twice the valid index interval (minimum `300`, default `1800`, maximum `86400`) |
| `DACS_REACHABILITY_MAX_PROBES` | No | Maximum due listing surfaces probed per reindex; defaults to `20` (bounded to `1..100`) |
| `DACS_REACHABILITY_CONCURRENCY` | No | Concurrent pinned HTTPS reachability probes; defaults to `5` (bounded to `1..10`) |
| `DACS_RECIPE_POLICIES` | For identity tier policy | JSON array of version-pinned DACS-2 recipe policies (`scheme`, `recipeVersion`, `methods`, `defaultMaxAgeSec`, `availability`, `trustedResultSigners`); absent/invalid policy leaves claims unverified for tiers; session admission does not use this policy |
| `DACS_RECIPE_SNAPSHOTS` | Helper only | JSON array of historical `{registryVersion, recipes}` snapshots for the standalone resolver. Production session admission does not consult this variable; operator authentication and graph integration are pending. |
| `DACS_TRUST_PROXY` | No | Set to `1` only behind a trusted proxy that overwrites client-IP headers; otherwise the in-process rate limiter is disabled and the deployment must enforce its edge limit |
| `NEXT_PUBLIC_DIRECTORY_URL` | Production | Public origin used by canonical URLs, sitemap, `llms.txt`, and machine-discovery documents; defaults to `http://localhost:3400`, which silently poisons production canonical URLs and the sitemap — the server logs a warning when unset in production |

The data directory must be persistent and writable in deployments that accept
registrations or run the indexer. Never commit `.indexer-seed`, `.indexer-mnemonic`,
or an admin token.

The exact Node release is pinned in `.nvmrc`, and `package.json` engines names the
same release; `test/node-runtime.test.mjs` fails if they diverge or if any other
file Railpack's mise reads could pick a release. CI installs Node from `.nvmrc`.
Railway's Railpack builder takes engines first and then lets `.nvmrc` override it
through mise's idiomatic version files (railpack `v0.41.0`,
`core/providers/node/node.go:419-494`), so production builds on the same release
either way. Leave `RAILPACK_NODE_VERSION` unset: `.nvmrc` overrides it. Railway does
not pin which Railpack release builds the service, so the build and
`start:railway` both run `npm run check:node-runtime` first, which fails unless the
running Node is the `.nvmrc` release. Before promoting a deployment, validate the
public canonical origin:

```bash
NEXT_PUBLIC_DIRECTORY_URL=https://directory.your-domain.org \
npm run check:deploy-config
```

The deployment check requires one credential-free HTTPS origin with no path, query,
or fragment, written exactly as that origin (an optional trailing `/` is allowed),
on a public host. Ports that browsers refuse to fetch (the Fetch Standard's bad
ports, including 0) are rejected.

- A host name needs at least two non-empty labels, must not end with a dot, and must
  not be, or end in, an IANA special-use name (`localhost`, `local`, `test`,
  `invalid`, `onion`, `alt`, or anything under `arpa`), the private-use `internal`,
  or `localdomain`. The RFC 6761 documentation names (`example`, `example.com`,
  `example.net`, `example.org`) are rejected too, unless the check runs with
  `--allow-documentation-names`, as CI does for its placeholder origin. Production
  builds (`railway.json`) run the check without it.
  Other names that are merely undelegated (for example `lan` or `corp`) are not
  rejected.
- An IP literal must be global unicast and outside every block in the IANA IPv4 and
  IPv6 Special-Purpose Address Registries. IPv4 rejects loopback, unspecified,
  private, shared (CGNAT), link-local, documentation, benchmarking, protocol
  assignments, AS112, AMT, reserved, and broadcast, plus multicast and the
  deprecated 6to4 relay block. IPv6 must be in `2000::/3`, outside the
  documentation, IETF-protocol (including Teredo), 6to4, Direct Delegation AS112,
  and `3fff::/20` blocks, so IPv4-mapped, NAT64, and other forms that embed an IPv4
  address are rejected.
- The check fails closed: the registries' globally reachable rows (PCP and TURN
  anycast inside `192.0.0.0/24`; AS112 and AMT; protocol anycast, ORCHIDv2, and
  DRIP inside `2001::/23`) are protocol addresses, not hosting space, and are
  rejected too.

`test/fixtures/origin-policy-sources.json` records where these rules come from:
every unexpired row of both IP registries (from Wireshark's IANA-generated tables,
which drop terminated rows and record an N/A Globally Reachable as false; the two
terminated blocks IANA still lists are rejected anyway), every special-use name
(IANA's registry XML from a mirror, cross-checked with Unbound and Knot Resolver),
and the Fetch Standard's bad ports. Each comes through a copy pinned to an upstream
revision and sha256 (as of 2026-10-15), plus the deliberate deviations. The tests
check the tables against it offline, and check the verifier against in-memory
copies; `npm run verify:origin-sources` (needs network) re-fetches each pinned copy
and checks the fixture against it. Node's `fetch` ignores `HTTPS_PROXY`, so behind
a proxy run `node --use-env-proxy scripts/verify-origin-sources.mjs` instead.
Generated canonical URLs and discovery documents therefore cannot silently point at
localhost or a different base path. The check does not resolve DNS, so a public name
that resolves to a private address still passes.

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
   anchored DACS artifacts by their self-describing program names, and attributes deals
   to sellers via the buyer-anchored agreement. Agents nobody registered appear as
   "discovered on-chain". Depth: `DACS_SCAN_MAX_TXS` (default 100000); a pass that
   hits the cap fails rather than advancing the cursor and silently skipping history.
   Revocation markers are recognised by their signed content, never by program name.
   Every candidate locator is queued once per listing hash; each pass examines
   at most 16 locators per listing — markers that already passed RB-4 first, then those
   anchored by the listing owner, then arrival order. The queue itself has no cap.
   An incomplete withdrawal check from a publisher-authenticated or operator-pinned
   well-known source is `indeterminate` (RB-5), so its listing is withheld from new
   discovery. Unauthenticated chain hints cannot create holds on independently
   discovered active listings. An unsigned revoked or incomplete index row cannot
   introduce an active offer; its binding must first resolve a verified marker, or
   a separate complete active source must establish discovery eligibility.
   Once a marker verifies, the listing stays `revoked` with its
   binding even if the marker later cannot be read (RB-3).
   A cached marker that passes RB-4 can establish revocation. A cached rejection
   requires a current marker read before rejecting the candidate or releasing a
   hold: at most 16 current reads and 32 cached/current checks per pass. Missing or
   unavailable reads keep authenticated holds across recrawls and restarts.
   BB-4-valid BundleBindings are also classified and kept, all of them: DACS-1 §6.3.6
   requires a carrying catalog to serve every such record whoever signed it, and
   `GET /api/dacs/bundles/{jobId}` pages through the full set (`limit`, `cursor`). The
   Directory's own BB-6 resolution works through at most eight per signer of each job and
   role; another signer's bindings never use that budget. Overflow is sticky and makes
   that signer's side `indeterminate`, never absent. There is no total across signers,
   so stored bindings, and the work to re-verify them each pass, grow with the number of
   bindings published for one job.
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
  Before any StorageProgram broadcast, the browser persists the public signed artifact,
  exact native/write coordinates and unsigned registration. A reload re-verifies that
  same anchor and refreshes only the catalog-pointer signature; it never creates another
  listing version or re-sends a chain transaction automatically.
- **Scanner depth is bounded** per pass. Increase `DACS_SCAN_MAX_TXS` if a backfill or
  unusually large interval exceeds the configured cap.
- **DACS-2 recipe governance is deployment policy.** Identity-tier derivation checks
  configured recipe version/method/availability/max-age and result signer policy.
  The new recipe snapshot resolver and required-claim matcher are standalone helpers;
  production session admission does not yet apply them. Their live-only policy does
  not change the existing tier path's availability handling.
- **Authority proof integration is pending.** Current graph and identity-tier paths
  check authority content hashes. The standalone `authenticateAuthorityAttestation`
  helper can delegate original proof/hash/signer/validator-epoch authentication to
  a method-specific verifier, but it has no production caller. A result signer's
  signature and a matching authority hash do not establish that authority proof.
- **Listing publication and listing/revocation verification use Unicode scalar values.**
  These paths reject lone UTF-16 surrogates in string values and property names before
  canonical hashing. Current reads accept bounded fractional JSON numbers; the frozen
  historical hash requires safe integers. Publication rejects fractional negotiation
  percentages with HTTP 400. Stored Listings and withdrawals also authenticate the
  previous SDK hash profile; new Listing admission uses the current profile.
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

This is a partial implementation of DACS-1 listing publication, well-known
files and catalog discovery, with current-artifact graph readers and a labelled
legacy SDK path. It does not claim complete DACS conformance. Session historical
identity/challenge/recipe admission, authority-proof authentication, native-payment
finality, rail snapshots, delivery cleartext/ACL verification and full agreement
conformance remain pending integration. Catalog computations are advisory and
independently reproducible from their refs; reference verification alone does not
establish payment or delivery.
Procurement listings remain outside this reader profile until reconciliation supports
the publisher as buyer and attributes supplier history to the agreement seller.

**Upstream source contracts.** The Directory records these source revisions:

- **DACS Standard**: `SPEC_PIN` records the source revision used by this partial implementation (v0.4,
  `4bb9e48`), the conformance vector files vendored under `test/fixtures/dacs-standard/`
  with their hashes and implementation limits. `test/standard-vectors.test.ts` checks
  SIG-6 encoding and Demos agent claim resolution. `test/listing-vectors.test.ts` and
  `test/revocation-vectors.test.ts` check the two listing/withdrawal fixture hashes and
  exercise the Directory's decisions. The revocation adapter explicitly excludes
  remote-catalog freshness, which this producer does not consume. Other upstream
  vector adapters remain pending. The `did:demos:agent` primary-claim profile is the
  deliberate addition; it comes from
  DACS-Standard #296 on `next` at `725fa78`, whose fixture is vendored too.
- **dacs-sdk**: `SDK_REV`, `STANDARD_REV`, patch digest and output digest in
  `scripts/setup-sdk.sh` pin the compiled compatibility build. It supplies current
  canonical hashing, Ed25519, CCI parsing and the labelled legacy verifier. Frozen
  historical hashes stay in the Directory. `/api/dacs/status` reports
  `legacyVetUnsupportedDeals`; these unverified deals do not contribute to reputation.
- **Demos node**: the read contract is pinned to `kynesyslabs/node` `ac8f45f`.
  `GET /storage-program/<address>` answers `{success: false, errorCode}` with 404
  `NOT_FOUND`, 403 `PERMISSION_DENIED` or 400 `INVALID_REQUEST` (an address without the
  `stor-` prefix), or `{success, owner, programName, data, ...}`; a program holds at most
  1 MiB (`STORAGE_PROGRAM_MAX_SIZE_BYTES`). The scanner labels HTTP 404 as
  `STORAGE_NOT_FOUND` only for a structured `errorCode: "NOT_FOUND"`
  answer. Bare, proxy and wrong-route 404 responses remain retryable
  `STORAGE_RPC_UNAVAILABLE`; structured 403 `PERMISSION_DENIED` is terminal for
  scanner replay. These diagnostics are not authoritative BB-8 absence.
  `test/scan-addresses.test.ts` checks the structured-node/proxy distinction and
  retry behavior; `test/chain-storage.test.ts` checks classified storage reads.
  This source pin does not
  attest the revision running at a remote RPC. The configured live service remains
  unpinned unless its operator supplies a verifiable deployment revision.

**Node deployment contract.** At `ac8f45f` the exact-name program search used by the
producer resume lookup is available as the public `gcr_routine
searchStoragePrograms` and `GET /storage-program/search?q=...&exact=true`; both
filter ACLs after pagination. A deployed node may also answer it as a `nodeCall` (node2 did on
2026-10-15). The Directory asks the `nodeCall` first and falls back to the `gcr_routine`
only on a recognized "Unknown message" answer. Both public search reads send JSON
headers without wallet authentication, as required by the pinned middleware contract. The fallback can recover a listing
after a fresh read confirms its owner. Its pages are ACL-filtered after pagination
and cannot establish absence, so an unresolved fallback lookup returns HTTP 503
and withholds new publication until a complete search contract is available.
`npm run check:node -- <exact program name>` is a read-only probe (no
transactions) that reports the storage not-found answer and both search paths, and fails
when they disagree, return no known program, or a fresh read cannot confirm one
matching public program. Its output is dated runtime evidence, not a pin. Run it when the
`DEMOS_RPC` deployment changes.

## License

MIT. This in-tree submission is covered by the Community repository's root
[`LICENSE`](../../LICENSE).

Current publishers use the registry IDs `demos-native:DEM` and `x402:default`, paired with
`pay-dem` and `pay-x402` phase kinds. Historical current-profile listings signed with phase
names as rail IDs remain readable as evidence, but are excluded from public discovery; publish
a new signed listing version to make those offers executable.

Well-known indexes can introduce offers after the Directory independently verifies
each listing's signature, publisher, chain owner and content hash. Source provenance
authorizes unresolved withdrawal holds. Use a seller publisher signature, or configure `DACS_WITHDRAWAL_SOURCE_PINS` as a
server-side JSON object mapping normalized HTTPS origins to canonical seller DIDs
(for example, `{"https://agent.example":"did:demos:agent:<64 lowercase hex>"}`).
Verify that seller/domain relationship independently before adding a pin. Public
domain submissions and listing endpoints do not create pins. An unsigned, unpinned
index can introduce independently verified offers and carry verified tombstones
for independently verified listings. Carried bindings are checked independently of
display metadata and status; a verified tombstone takes precedence over incomplete
index metadata. A pinned unsigned index retains incomplete withdrawal
checks until a completed check from that same source or a verified revocation.

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

Fixed-price agreements on negotiable listings (including signed RFQ fixed-price
fallback) are readable for listing discovery. Their deal evidence remains unverified
and excluded from completion, ratings and volume until semantic agreement, settlement
and delivery verification adapters support that combination.

Authenticated revocation bindings survive newer active index advertisements and
process restarts. An unread marker continues to withhold the offer until a successful
read rejects it or verifies revocation; verified revocation takes precedence.
Rejection is applied only while the captured source revision is current, so a slow
read cannot clear a newer advertisement even when it references the same marker scope.

The x402, AP2, EVM/EIP, SPL and HTLC names mirror the pinned DACS-4 rail registry.
Independent protocol revisions and live handler compatibility are not asserted by
these identifiers; any future live handler must pin and test its upstream contract.

The optional `dacs.listings.publisherSignature` is a Directory extension to DACS-1
§6.3.5. Sign these exact UTF-8 bytes (LF separators, no final newline):

```text
dacs-directory withdrawal-index:v1
domain:https://seller.example
index:sha256-<64 lowercase hex digits>
```

`domain` is the normalized submitted HTTPS origin (lowercase hostname, no path or
trailing slash, default port omitted). The hash is SHA-256 of the exact served
index bytes, including whitespace. Use the Ed25519 key identified by the index's
`seller` (`did:demos:agent:<64 lowercase hex>`). Encode the raw 64-byte signature
as canonical unpadded Base64URL (86 characters, zero residual bits); padded,
standard Base64 and hex encodings are rejected. The signature is stored in the
agent card, outside the hashed index. Changing the origin or index bytes requires
a new signature.

New current-profile listings require SIG-6 canonical Base64URL `signature.value`.
To retain immutable versions published by the previous Directory hex publisher,
set `DACS_HISTORICAL_LISTING_IMPORTS` to an operator-controlled JSON object keyed
by native `stor-` address. Inventory authenticated pre-upgrade publications before
upgrading; each entry declares `encoding: "lowercase-hex"`, `sellerPrimaryClaim`,
`listingId`, `listingVersion` and the exact unsigned `contentHash` (64 lowercase hex
characters). This is an explicit local trust input, never a field accepted from
registration requests, index rows or the listing itself. At most 256 entries and
65,536 UTF-8 bytes are accepted; malformed or incomplete pins cannot import hex.

Every historical read rechecks the original signatures, current schema and pinned
tuple/hash. The importer normalizes only the envelope in memory, retaining the
original stored bytes and native pointer. Catalog, detail, derivation, withdrawal,
completed-session and publication recovery reads share it. Recovery returns the
same stored artifact without a new transaction. Unpinned current hex artifacts
remain rejected; the labelled draft SDK profile keeps its separate reader.
`test/historical-listing-import.test.ts`, `test/current-indexer.test.ts` and
`test/build-listing.test.ts` cover import boundaries and immutable history/recovery.

**Listings that /register published.** The reader is the pinned SDK Listing shape plus
this catalog's profile. The identity presentation also accepts the earlier publisher's
wallet hex and the Standard vector's padded Base64 beside Base64URL; the Listing
signature stays SIG-6 Base64URL. A string `verificationMethod` is refused, a revocation
marker accepts a numeric `revokedAt` within ±(2^53−1), and its binding carries the exact `presentedBy`
(RB-2). `test/listing-verification.test.ts` and `test/revocation-vectors.test.ts` pin them.
