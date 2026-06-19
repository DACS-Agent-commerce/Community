"""DACS spec-reference MCP server (read, search, and fetch + conformance vectors).

Source of truth: a pinned local checkout of github.com/DACS-Agent-commerce/DACS-Standard.

Multi-file ingestion of CORE + 5 stage modules + 4 companion
references per upstream scripts/specsource.py SPEC_FILES (mirrored verbatim).
Conformance vectors / fixtures surfaced via the new dacs_get_conformance_vectors
tool, manifest fields passed through verbatim.

Version from CHANGELOG.md `## [N.M] — YYYY-MM-DD`. Commit via `git rev-parse HEAD`.

Every tool response wraps {dacs_version, version_date, commit, spec_path, spec_paths, result}.
Server returns verbatim spec slices — never paraphrases, never restates.

Transport: stdio default. HTTP flag is accepted but not hosted yet; falls back to
stdio with a stderr notice so the consumer surface stays unchanged.

Run:
    DACS_SPEC_PATH=/path/to/DACS-Standard python server.py [--transport stdio|http]

If DACS_SPEC_PATH is unset, the server reads from `vendor/DACS-Standard/`
relative to this file (the layout produced by `./setup_spec.sh`).

Requires: `mcp` (Anthropic's official MCP SDK / FastMCP).
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any, Dict, Optional

# Allow imports from this directory.
sys.path.insert(0, str(Path(__file__).parent))

from indexer import DacsIndex, format_response  # noqa: E402


CONFORMANCE_PLAN_NOTE = (
    "Plan text. For the test vectors themselves, use dacs_get_conformance_vectors "
    "(MANIFEST.json passthrough + verbatim file bytes)."
)


def _default_repo_path() -> Path:
    """Default vendor location: `vendor/DACS-Standard/` relative to this file.

    This matches the layout produced by `./setup_spec.sh`, which clones
    DACS-Agent-commerce/DACS-Standard into that path and checks out the
    commit pinned in `SPEC_PIN`. Override via the `DACS_SPEC_PATH` env var.
    """
    return Path(__file__).parent / "vendor" / "DACS-Standard"


def _build_index() -> DacsIndex:
    repo_path = Path(os.environ.get("DACS_SPEC_PATH", str(_default_repo_path())))
    idx = DacsIndex(repo_path)
    idx.build()
    return idx


# Build the index once at import time so each MCP request is O(query), not O(spec).
INDEX = _build_index()


try:
    from mcp.server.fastmcp import FastMCP
except ImportError as e:
    print(
        f"FATAL: cannot import mcp.server.fastmcp ({e}). "
        "Install with: pip install mcp",
        file=sys.stderr,
    )
    raise


mcp = FastMCP("dacs-spec")


@mcp.tool()
def dacs_search(query: str) -> Dict[str, Any]:
    """Lexical (deterministic, no embeddings) search across sections, rules, and schemas.

    Returns ranked hits with anchor, chapter, and a verbatim snippet.
    """
    return format_response(INDEX, {"query": query, "hits": INDEX.search(query)})


@mcp.tool()
def dacs_get_section(ref: str, chapter_hint: Optional[str] = None) -> Dict[str, Any]:
    """Get a verbatim section by §-ref (e.g. '7.4.5', '14.6', '§6.3.4').

    If the ref is ambiguous across the duplicate §6 / §7 namespaces
    (front-matter "## N." vs Chapter wrapper "## Chapter N —"), returns BOTH
    candidates labelled by chapter unless `chapter_hint` disambiguates.
    `chapter_hint` accepts a chapter substring ("DACS-1", "Chapter 6") or "front"
    for the front-matter candidate.
    """
    return format_response(INDEX, INDEX.get_section(ref, chapter_hint=chapter_hint))


@mcp.tool()
def dacs_get_rule(rule_id: str) -> Dict[str, Any]:
    """Get the verbatim rule text + section anchor for a rule id (e.g. 'HTLC-7', 'RAV-R1').

    Rule text is line-bounded — extracted between consecutive `(FAMILY-ID)` labels
    on the same source line, with the line's preamble retained as context.

    The SR family (SR-1..SR-5) is the substrate-requirement set from §5 and is
    returned with `is_conformance: false` and a clarifying note.
    """
    return format_response(INDEX, INDEX.get_rule(rule_id))


@mcp.tool()
def dacs_list_rule_family(prefix: str) -> Dict[str, Any]:
    """List rules in a family by prefix (e.g. 'HTLC', 'RAV', 'RAV-R', 'SIG').

    `RAV` and `RAV-R` are kept distinct (recipes §7.4.5 vs rails §9.4.5).
    Returns one-liner extracts ordered by id.
    """
    members = INDEX.list_rule_family(prefix)
    return format_response(INDEX, {"family": prefix, "count": len(members), "members": members})


@mcp.tool()
def dacs_get_artifact_schema(name: str) -> Dict[str, Any]:
    """Get a schema's verbatim fence block plus the BONDED canonical-hash /
    domain-separator / signing-payload prose that follows it in the spec.

    `name` is a TitleCase type name as it appears in the spec
    (e.g. 'VerifyResult', 'Listing', 'AttestationBundle', 'AgreementDocument').
    """
    return format_response(INDEX, INDEX.get_artifact_schema(name))


@mcp.tool()
def dacs_get_conformance_plan(stage: Optional[str] = None) -> Dict[str, Any]:
    """Get the §14 conformance plan verbatim.

    `stage` accepts a sub-ref like '14.1', '14.6', or omitted for the full chapter.

    returns the body (CONFORMANCE-PLAN.md), not the CORE redirect stub.
    """
    plan = INDEX.get_conformance_plan(stage)
    if "error" not in plan:
        plan["note"] = CONFORMANCE_PLAN_NOTE
    return format_response(INDEX, plan)


@mcp.tool()
def dacs_get_conformance_vectors(
    vector_id: Optional[str] = None,
    vector_file: Optional[str] = None,
    fixture_path: Optional[str] = None,
) -> Dict[str, Any]:
    """surface conformance/MANIFEST.json + vectors + fixtures verbatim.

    Four call shapes (positional-lookup args mutually exclusive — at most one set):
    - No args → list every MANIFEST case verbatim with manifest_metadata
      attached, PLUS a vector_files list of every standalone .json file
      under conformance/vectors/ (filename + size_bytes only). The
      vector_files list is how lifecycle vectors that aren't MANIFEST cases
      become discoverable.
    - vector_id="X" → return the manifest case for id X + the host vector
      file's bytes verbatim.
    - vector_file="X.json" → fetch a standalone file under
      conformance/vectors/ jailed via path-traversal guard. Use for
      dacs-v0.1-happy-path.json, dacs-v0.1-negative-paths.json, or any
      file in subdirectories (e.g. examples/identity-bundle.json).
    - fixture_path="X" → fetch a fixture under conformance/fixtures/, jailed
      via the same guard pattern.

    Every response carries the standard {dacs_version, version_date, commit,
    spec_path, spec_paths} stamp. Field discipline: every MANIFEST field is
    passed through verbatim; file_path is the only field added beyond what
    upstream wrote.
    """
    return format_response(
        INDEX,
        INDEX.get_conformance_vectors(
            vector_id=vector_id,
            vector_file=vector_file,
            fixture_path=fixture_path,
        ),
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="DACS spec-reference MCP server"
    )
    parser.add_argument(
        "--transport",
        choices=["stdio", "http"],
        default="stdio",
        help="Transport. stdio is the default. --transport http is "
             "accepted as a flag but does not host yet; it falls back to stdio.",
    )
    args = parser.parse_args()

    if args.transport == "http":
        print(
            "[dacs-spec] --transport http accepted but HTTP hosting is held "
            "follow-on. Falling back to stdio.",
            file=sys.stderr,
        )

    print(
        f"[dacs-spec] ready — version {INDEX.version} ({INDEX.version_date}) "
        f"commit {INDEX.commit[:12]} sections={len(INDEX.sections)} "
        f"rules={len(INDEX.rules)} schemas={len(INDEX.schemas)}",
        file=sys.stderr,
    )

    mcp.run(transport="stdio")
    return 0


if __name__ == "__main__":
    sys.exit(main())
