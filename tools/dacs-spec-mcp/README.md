# `dacs-spec-mcp` — DACS spec-reference MCP server

A Model Context Protocol (MCP) server that lets LLM-driven tools query the
DACS-Standard specification verbatim, with byte-equal slices and per-line
file provenance. Built against a **pinned** local checkout of
[DACS-Agent-commerce/DACS-Standard](https://github.com/DACS-Agent-commerce/DACS-Standard);
the pin is recorded in `SPEC_PIN` and the spec text is never restated or
paraphrased.

This is a non-normative reference tool. The DACS-Standard specification text
remains authoritative; this server serves it verbatim.

## What it serves — seven tools

| Tool | What it returns |
|---|---|
| `dacs_search` | Lexical search across sections, rules, and schemas. Returns ranked hits with anchor, chapter, and a verbatim snippet. |
| `dacs_get_section` | All sections matching a `§`-ref in `SPEC_FILES` concatenation order, each tagged `kind: "body"` or `kind: "redirect"` with `(file, line_in_file)` provenance. The dual-residence of §A and ch.12/13/14 (CORE redirect stub + companion body) surfaces as two matches; the caller decides. |
| `dacs_get_rule` | Every def-form site for a rule ID (e.g. `HTLC-7`, `CF-4`, `RAV-R1`), in concatenation order. Each site tagged `form: "paren-def"` or `"word-def"` (or `"table-row"` for SR-N) with `(file, line_in_file, §)`. A rule hoisted from one module to CORE returns both its paren-def and its word-def site verbatim. |
| `dacs_list_rule_family` | Members of a rule family (e.g. `HTLC`, `RAV-R`, `SIG`, `CF`) with a one-line extract from each rule's primary site. Hyphenated families (`RAV-R`, `VP-R`) attribute correctly per the upstream `rule_family()` logic. |
| `dacs_get_artifact_schema` | A schema's verbatim fence block plus the bonded canonical-hash / domain-separator / signing-payload prose that follows it. Names are TitleCase (`VerifyResult`, `AttestationBundle`, `Listing`, …). |
| `dacs_get_conformance_plan` | The `§14` conformance plan verbatim. Returns the body from `CONFORMANCE-PLAN.md`, not the CORE redirect stub. |
| `dacs_get_conformance_vectors` | Surfaces `conformance/MANIFEST.json` + vector files + fixtures. Four call shapes: no args (list every MANIFEST case + standalone `vector_files`), `vector_id=`, `vector_file=`, `fixture_path=`. Path-traversal guarded; mutual-exclusion across all three lookup args. |

## Version-stamp contract

Every tool response is wrapped in:

```json
{
  "dacs_version":  "0.1",
  "version_date":  "2026-05-31",
  "commit":        "b3646aa4eea10226e5c0a45175c8f9708df9d758",
  "spec_path":     "<vendor>/spec/CORE.md",
  "spec_paths":    [ "<vendor>/spec/CORE.md", …, "<vendor>/spec/CONFORMANCE-PLAN.md" ],
  "result":        { … }
}
```

- `dacs_version` and `version_date` come from `CHANGELOG.md` (`## [N.M] — YYYY-MM-DD`).
- `commit` is `git rev-parse HEAD` of the pinned checkout — the same hash recorded in `SPEC_PIN`.
- `spec_paths` lists every authored-order file the index was built from
  (mirrors upstream `scripts/specsource.py::SPEC_FILES` verbatim — CORE +
  five stage modules + four companions; PRIMER.md and `spec/PROFILE.md`
  are deliberately excluded per the upstream validators).

The stamp lets a downstream consumer prove which exact spec text any answer
came from.

## No-drift design

- **Pinned vendor.** Spec text is read from a local checkout at a fixed
  commit (`SPEC_PIN`). Upstream is never reached at request time.
- **Verbatim slices, no paraphrase.** Tool responses are byte-equal lifts
  from the source files. Section bodies, rule lines, schema fences, and
  conformance vectors are returned as their source bytes.
- **Per-line provenance.** Every section, rule site, and schema carries
  `(file, line_in_file)` for the source position. The concat-stream `line`
  is exposed too, but `(file, line_in_file)` is what citations should use.
- **Upstream regex set + skip-list adopted wholesale.** The rule-ID
  extraction mirrors `scripts/validate_rule_ids.py`'s `PAREN_DEF_RE`,
  `RULE_WORD_DEF_RE`, `SKIP_PREFIXES`, and `rule_family()` — verbatim,
  with citation comments — so this server's view matches upstream's
  own validators.
- **Multi-residence rules.** A rule can appear as a paren-def in one
  file and a word-def in another (typical hoist pattern: definition
  body in a stage module, canonical reference word-def in `CORE §B.x`).
  Every def-form site is returned; prose cross-references (bare
  `CF-4 governs …` mentions) are not indexed.

## Setup

The repo deliberately ships **no vendored spec text**. You run one
script to fetch the pinned checkout, build a venv, and verify
everything from end to end.

**Requires Python ≥ 3.10** (the `mcp` SDK does not publish wheels for
older versions).

```bash
# 1. From this directory, clone DACS-Standard at the SPEC_PIN commit.
#    Creates vendor/DACS-Standard/ and exits non-zero on any failure.
./setup_spec.sh

# 2. Build the venv (use python3.10+; python3.12 is what this README was
#    verified against).
python3.12 -m venv venv
./venv/bin/pip install -r requirements.txt

# 3. Run the smoke test — exits 0 on success.
./venv/bin/python smoke_test.py
```

The smoke test exercises all seven tools, asserts the locked counts
(196 sections / 152 rules / 64 schemas at the pinned commit), checks
multi-residence (CF-4 has five sites; CD-1 has five including the
CORE §B.2 word-def and DACS-3 §8.5.1 paren-def), and verifies that
three rules (one CF in CORE §B.1, one VP-R in DACS-2, one HTLC in
DACS-4) return text byte-equal to the source file lines at their
indexed coordinates.

To override the vendor location at runtime, set `DACS_SPEC_PATH`:

```bash
DACS_SPEC_PATH=/elsewhere/DACS-Standard ./venv/bin/python server.py
```

## Run the server

```bash
./venv/bin/python server.py [--transport stdio]
```

`stdio` is the only transport currently implemented; `--transport http`
is accepted as a flag but falls back to `stdio` with a stderr notice.

## Update the pin

1. Edit `SPEC_PIN` — replace the 40-char hash with the new target commit.
2. Re-run `./setup_spec.sh` to fetch and check out the new commit.
3. Re-run `smoke_test.py`. The locked count assertions in the smoke test
   will fail if the new commit changes section / rule / schema counts —
   update those assertions deliberately, and re-verify the byte-equal
   trio and multi-residence assertions, before considering the new pin
   trusted.

## Layout

```
tools/dacs-spec-mcp/
├── README.md            (this file)
├── SPEC_PIN             40-char upstream commit hash + comment line
├── setup_spec.sh        clones upstream + checks out SPEC_PIN; exits nonzero on failure
├── requirements.txt     mcp==1.27.2
├── .gitignore           ignores vendor/ and venv/
├── indexer.py           multi-file ingestion + multi-site rule index + verbatim getters
├── server.py            FastMCP wrapper — registers the seven tools
├── smoke_test.py        end-to-end verification, exits 0 on success
└── vendor/              created by setup_spec.sh — not committed
    └── DACS-Standard/   pinned checkout
```

## Disclaimer

This server is a non-normative reference tool. The
[DACS-Standard](https://github.com/DACS-Agent-commerce/DACS-Standard)
specification text remains authoritative; this server serves it verbatim
from a pinned checkout. Any conflict between what this server returns
and what the specification says is a bug in this server.
