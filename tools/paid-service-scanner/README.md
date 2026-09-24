# Paid-service candidate scanner

This is a bounded, public-only discovery scanner for MCP and WebMCP services
whose directory metadata contains evidence that access may be paid. It produces
candidate records for later review; it does not create DACS Listings.

MCP Registry coverage is explicitly **server-level only**. The Registry feed
does not contain runtime `tools/list` results, the scanner does not connect to
listed servers, and MCP candidates therefore have `inventoryLevel: "server"`
and `tool: null`. WebMCP directory candidates can be tool-level. This output is
not a per-tool MCP inventory.

The scanner reads only these fixed public APIs:

- the official MCP Registry server feed;
- the `webmcp.com` public tools feed; and
- the `wmcp.ai` public sites and site-detail feeds.

It does not connect to discovered MCP servers, execute WebMCP tools, follow
provider links, use authentication, read credentials, make purchases, or make
paid calls. HTTP redirects outside the API host allowlist are rejected. Each
response is capped at 5 MiB, each request has a timeout, pagination is capped,
and `wmcp.ai` detail requests have a separate cap.

## Run

Python 3.10 or newer is sufficient; there are no third-party dependencies.
The default mode replays committed fixtures and makes no network requests:

```bash
cd tools/paid-service-scanner
python3 scanner.py --mode fixture --pretty --output scan.json
python3 -m unittest -v
```

A small live sample across all three sources:

```bash
python3 scanner.py \
  --mode live \
  --sources all \
  --max-pages 2 \
  --page-size 25 \
  --max-site-details 25 \
  --timeout 8 \
  --pretty \
  --output scan.json
```

The process exits `0` for a complete bounded scan and `2` when one or more
source/page/detail requests failed. Partial results and structured failures are
still written. Use `--output -` for stdout. Limits are validated by the CLI;
`--max-pages` and `--page-size` cannot exceed 100, detail requests cannot
exceed 500, and the timeout cannot exceed 30 seconds.

## Evidence model

The classifier deliberately ignores tool names and ordinary commerce actions.
A tool called `pay_invoice` that pays a shopper's invoice is not evidence that
using the tool costs money.

Candidate payment states are:

| Status | Meaning | Confidence |
|---|---|---|
| `reported_explicit_price` | Directory text states an access price or a pay-per-call/run/request model | medium |
| `reported_explicit_subscription` | Directory text states that a paid subscription or plan is required | medium |
| `inferred_paid_lead` | Directory text weakly associates access with a premium tier or upgrade | low |

All current directory evidence is `reported_unverified` or `inferred_only`.
Even official-registry metadata is not treated as proof that a price is current.
Provider-side verification is intentionally outside this MVP because it would
require fetching arbitrary discovered URLs. Every evidence item retains its API
URL, source field, matched snippet, publisher relationship, and observation
time so a later verification stage can review it.

## Output

The JSON document includes:

- the scanner policy and execution bounds;
- per-source page, record, and detail counts;
- candidates deduplicated by protocol, normalized service ID/host, and tool
  name (`*` for MCP Registry entries, because the Registry does not list tools);
- evidence status, confidence, snippets, source URLs, and timestamps; and
- recoverable source failures without discarding partial results.

Each source has a `coverage` object. `paginationExhausted` is true only when
the source reported no next page (or its offset reached `total`). Reaching
`maxPages` leaves it false with `stopReason: "max_pages"`. For `wmcp.ai`,
`siteDetailCapReached` separately records when summaries were found for more
sites than the configured detail cap. Either condition makes the source
`partial`, even when every attempted HTTP request succeeded.

Historical MCP Registry versions are deduplicated by normalized server name,
preferring `isLatest`, then active status and the newest registry timestamp.
WebMCP entries are deduplicated by normalized host and tool name. Cross-directory
duplicates merge provenance when their normalized identity is the same.

## Known gaps

- Public directories are incomplete and may be stale or wrong. Private,
  authenticated, session-created, and unlisted tools are invisible.
- The MCP Registry describes servers, not their runtime `tools/list`, so MCP
  candidates are server-level until a separately authorized discovery stage
  inspects tools.
- The phrase matcher favors precision and misses novel pricing language. It
  does not interpret linked pricing pages, schemas, images, or JavaScript.
- No provider-side price verification occurs. Candidates must not be published
  as DACS Listings or represented as verified offers without a later review.
- Deduplication is syntactic; aliases and related domains may remain separate.
- A source can change its undocumented response shape. Such failures are
  recorded in `failures` and cause exit status `2`.
