"""Smoke test for the DACS spec indexer.

Exercises every tool surface against the multi-file spec set (CORE + 5 DACS
modules + 4 companions) at the pinned vendor commit, plus targeted assertions:

- Byte-equal trio: site.line_text == source-file line for CF (CORE §B.1),
  VP-family (DACS-2 §7.6.1), HTLC-family (DACS-4 §9.5.4).
- Multi-residence: CF-4 has 5 sites (1 paren-def + 4 word-def at the
  reported locations); CD-1 has 5 sites including CORE §B.2 word-def AND
  DACS-3 §8.5.1 paren-def.
- Lifecycle-vector reachability: vector_files list surfaces
  dacs-v0.1-happy-path.json + dacs-v0.1-negative-paths.json; vector_file=
  fetches them; path-traversal guard rejects escape attempts.
- Dual-residence sections: §A and ch.12/13/14 return both redirect-stub
  (CORE) and body (companion) matches.

Hits the indexer directly — no `mcp` package required.
Exit 0 required.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from indexer import DacsIndex, format_response  # noqa: E402


BAR = "═" * 78
DASH = "─" * 78


def banner(label: str) -> None:
    print()
    print(BAR)
    print(label)
    print(BAR)


def show(label: str, env: dict) -> None:
    print()
    print(DASH)
    print(label)
    print(DASH)
    print(json.dumps(env, indent=2, default=str)[:2400])


def _default_repo_path() -> Path:
    """Mirror server.py's default: `vendor/DACS-Standard/` relative to this file."""
    return Path(__file__).parent / "vendor" / "DACS-Standard"


def main() -> int:
    repo_path = Path(os.environ.get("DACS_SPEC_PATH", str(_default_repo_path())))
    # spec is multi-file. Probe CORE.md as the canonical first file.
    if not (repo_path / "spec" / "CORE.md").is_file():
        print(f"ERROR: DACS spec not at {repo_path}. Run ./setup_spec.sh first "
              "(or set DACS_SPEC_PATH to your vendor checkout).",
              file=sys.stderr)
        return 1

    idx = DacsIndex(repo_path)
    idx.build()

    banner("DACS SPEC MCP — INDEX BUILD REPORT")
    print(f"  spec_paths:      {len(idx.spec_paths)} files")
    print(f"  commit:          {idx.commit}")
    print(f"  version:         {idx.version} ({idx.version_date})")
    print(f"  sections:        {len(idx.sections)}")
    print(f"  rules:           {len(idx.rules)}")
    print(f"  schemas:         {len(idx.schemas)}")
    print(f"  manifest cases:  "
          f"{len((idx.manifest or {}).get('cases', [])) if idx.manifest else 'N/A'}")

    # Locked count assertions reporting requirement.
    assert len(idx.sections) == 196, f"section count: expected 196, got {len(idx.sections)}"
    assert len(idx.rules)    == 152, f"rule count: expected 152, got {len(idx.rules)}"
    assert len(idx.schemas)  ==  64, f"schema count: expected 64, got {len(idx.schemas)}"

    # ── TOOL 1/7 — dacs_get_artifact_schema ────────────────────────────
    out = idx.get_artifact_schema("VerifyResult")
    show("TOOL 1/7 — dacs_get_artifact_schema('VerifyResult')",
         format_response(idx, out))
    assert "type VerifyResult = {" in out.get("fence_block", "")
    assert "dacs-verifyresult:v1:" in out.get("bonded_prose", "")
    assert out.get("section") == "§7.5"
    assert out.get("file", "").endswith("DACS-2-VET.md"), \
        f"VerifyResult should anchor in DACS-2-VET.md, got file={out.get('file')}"

    # ── TOOL 2/7 — dacs_get_rule (HTLC-7, multi-site) ──────────────────
    out = idx.get_rule("HTLC-7")
    show("TOOL 2/7 — dacs_get_rule('HTLC-7')", format_response(idx, out))
    assert out.get("site_count", 0) >= 1
    assert out.get("family") == "HTLC"
    assert out.get("is_conformance") is True
    # Find the canonical definition site — the bullet at L443 "- (HTLC-7) **Timelock asymmetry.**"
    primary = next(
        (s for s in out["sites"]
         if s["section"] == "§9.5.4" and "Timelock asymmetry" in s["line_text"]),
        None,
    )
    assert primary is not None, "HTLC-7 canonical-def site (DACS-4 §9.5.4 'Timelock asymmetry') missing"
    assert primary["file"].endswith("DACS-4-SETTLE.md")
    assert primary["form"] == "paren-def"

    # ── TOOL 3/7 — dacs_get_rule (RAV-R1, hyphenated family) ───────────
    out = idx.get_rule("RAV-R1")
    show("TOOL 3/7 — dacs_get_rule('RAV-R1')", format_response(idx, out))
    assert out.get("family") == "RAV-R", \
        f"RAV-R1 family should be RAV-R (not RAV), got {out.get('family')}"
    # RAV-R1 has multiple sites (cross-ref at §9.4.2 + canonical def at §9.4.4).
    # Find the canonical bullet-list def — starts with "- (RAV-R1) ".
    canonical = next(
        (s for s in out["sites"]
         if s["line_text"].lstrip().startswith("- (RAV-R1)")),
        None,
    )
    assert canonical is not None, "RAV-R1 canonical bullet-list def missing"
    assert canonical["file"].endswith("DACS-4-SETTLE.md")
    assert "inspect rail availability" in canonical["line_text"]

    # ── TOOL 4/7 — dacs_get_section ────────────────────────────────────
    out = idx.get_section("7.4.5")
    show("TOOL 4/7 — dacs_get_section('7.4.5')", format_response(idx, out))
    assert out.get("match_count") == 1
    m = out["matches"][0]
    assert "Recipe availability" in m["title"]
    assert "availability" in m["text"].lower()
    assert m["kind"] == "body"

    # ── TOOL 4b/7 — dual-residence (§A + ch.12/13/14) ────────
    for ref, expected_redirect_file, expected_body_file in (
        ("A",  "spec/CORE.md", "spec/DEMOS-MAPPING.md"),
        ("12", "spec/CORE.md", "spec/THREAT-MODEL.md"),
        ("13", "spec/CORE.md", "spec/GLOSSARY.md"),
        ("14", "spec/CORE.md", "spec/CONFORMANCE-PLAN.md"),
    ):
        out = idx.get_section(ref)
        assert out.get("match_count") == 2, \
            f"§{ref} should have 2 matches (redirect + body), got {out.get('match_count')}"
        kinds = {m["kind"]: m["file"] for m in out["matches"]}
        assert kinds.get("redirect") == expected_redirect_file
        assert kinds.get("body") == expected_body_file

    # ── TOOL 5/7 — dacs_list_rule_family ───────────────────────────────
    members = idx.list_rule_family("SIG")
    show("TOOL 5/7 — dacs_list_rule_family('SIG')",
         format_response(idx, {"family": "SIG", "count": len(members), "members": members}))
    sig_ids = {m["rule_id"] for m in members}
    assert {"SIG-1", "SIG-2", "SIG-3", "SIG-4", "SIG-5"} <= sig_ids

    # ── TOOL 6/7 — dacs_search ─────────────────────────────────────────
    hits = idx.search("timelock asymmetry")
    show("TOOL 6/7 — dacs_search('timelock asymmetry')",
         format_response(idx, {"query": "timelock asymmetry", "hits": hits[:5]}))
    assert hits
    rule_anchors = [h["anchor"] for h in hits if h["kind"] == "rule"]
    assert "HTLC-7" in rule_anchors

    # ── TOOL 7/7 — dacs_get_conformance_plan ───────────────────────────
    cp = idx.get_conformance_plan("14.6")
    show("TOOL 7/7 — dacs_get_conformance_plan('14.6')",
         format_response(idx, cp))
    assert cp.get("kind") == "body", \
        "get_conformance_plan should return body, not the CORE redirect stub"
    assert cp.get("file") == "spec/CONFORMANCE-PLAN.md"
    assert "SIG-1" in cp.get("text", "")

    # ── SR-4 substrate requirement (table-row form) ────────────────────
    out = idx.get_rule("SR-4")
    assert out.get("is_conformance") is False
    assert "substrate requirement" in out.get("note", "").lower()
    site = out["sites"][0]
    assert site["form"] == "table-row"
    assert site["section"] == "§5"
    assert "Identity-keyed private coordination channels" in site["line_text"]

    # ── PHASE 4 — byte-equal trio ──────────────────────────────────────
    banner("PHASE 4 — BYTE-EQUAL TRIO")
    trio = (
        ("CF-2",  "spec/CORE.md",          "§B.1",   "paren-def"),
        ("VP-R4", "spec/DACS-2-VET.md",    "§7.6.1", "paren-def"),
        ("HTLC-7","spec/DACS-4-SETTLE.md", "§9.5.4", "paren-def"),  # multiple sites; check L443
    )
    for rid, expected_file, expected_section, expected_form in trio:
        rule = idx.rules.get(rid)
        assert rule is not None, f"trio rule {rid} missing"
        site = next(
            (s for s in rule.sites
             if s.file == expected_file and s.section_number == expected_section.lstrip("§")
             and s.form == expected_form),
            None,
        )
        assert site is not None, \
            f"trio site missing: {rid} {expected_form} {expected_file} {expected_section}"
        # Byte-equal check: site.line_text must equal the source file's line.
        source_lines = (repo_path / expected_file).read_text(encoding="utf-8").splitlines()
        source_line = source_lines[site.line_in_file - 1]
        assert site.line_text == source_line, (
            f"BYTE-EQUAL FAIL {rid} at {expected_file}:{site.line_in_file}\n"
            f"  indexer: {site.line_text[:120]!r}\n"
            f"  source:  {source_line[:120]!r}"
        )
        print(f"  ✓ {rid:<8s} {expected_file}:{site.line_in_file:<5d} "
              f"({len(source_line)} chars) — BYTE-EQUAL")

    # ── PHASE 4 — multi-residence assertions ───────────────────────────
    banner("PHASE 4 — MULTI-RESIDENCE")
    cf4 = idx.get_rule("CF-4")
    assert cf4.get("site_count") == 5, \
        f"CF-4 site_count expected 5, got {cf4.get('site_count')}"
    cf4_forms = sorted(s["form"] for s in cf4["sites"])
    assert cf4_forms == ["paren-def", "word-def", "word-def", "word-def", "word-def"], \
        f"CF-4 form breakdown wrong: {cf4_forms}"
    cf4_sites = [(s["form"], s["file"], s["section"]) for s in cf4["sites"]]
    print(f"  ✓ CF-4: 5 sites = {cf4_forms}")
    for s in cf4["sites"]:
        print(f"      {s['form']:<10s} {s['section']:<8s} {s['file']}:{s['line_in_file']}")

    cd1 = idx.get_rule("CD-1")
    assert cd1.get("site_count") == 5, \
        f"CD-1 site_count expected 5, got {cd1.get('site_count')}"
    # Must contain CORE §B.2 word-def AND DACS-3 §8.5.1 paren-def per JB's spec.
    has_core_b2_worddef = any(
        s["form"] == "word-def" and s["section"] == "§B.2"
        and s["file"] == "spec/CORE.md"
        for s in cd1["sites"]
    )
    has_dacs3_851_parendef = any(
        s["form"] == "paren-def" and s["section"] == "§8.5.1"
        and s["file"] == "spec/DACS-3-NEGOTIATE.md"
        for s in cd1["sites"]
    )
    assert has_core_b2_worddef, "CD-1 missing CORE §B.2 word-def site"
    assert has_dacs3_851_parendef, "CD-1 missing DACS-3 §8.5.1 paren-def site"
    print(f"  ✓ CD-1: 5 sites incl. CORE §B.2 word-def + DACS-3 §8.5.1 paren-def")
    for s in cd1["sites"]:
        print(f"      {s['form']:<10s} {s['section']:<8s} {s['file']}:{s['line_in_file']}")

    # ── PHASE 4 — conformance-vector reachability ──────────────────────
    banner("PHASE 4 — CONFORMANCE-VECTOR REACHABILITY")
    no_arg = idx.get_conformance_vectors()
    assert no_arg.get("case_count") == 186, \
        f"manifest case count: expected 186, got {no_arg.get('case_count')}"
    vfiles = no_arg.get("vector_files", [])
    vfile_names = {f["filename"] for f in vfiles}
    assert "dacs-v0.1-happy-path.json" in vfile_names
    assert "dacs-v0.1-negative-paths.json" in vfile_names
    # Field discipline: vector_files entries carry filename + size_bytes only.
    for f in vfiles:
        assert set(f.keys()) == {"filename", "size_bytes"}, \
            f"vector_files entry carries invented metadata: {set(f.keys())}"
    print(f"  ✓ no-arg: 186 manifest cases + {len(vfiles)} vector_files entries")
    print(f"    filenames: {sorted(vfile_names)}")

    hp = idx.get_conformance_vectors(vector_file="dacs-v0.1-happy-path.json")
    assert hp.get("file_path") == "conformance/vectors/dacs-v0.1-happy-path.json"
    source = (repo_path / "conformance/vectors/dacs-v0.1-happy-path.json").read_text(encoding="utf-8")
    assert hp["file_bytes"] == source, "happy-path vector bytes diverged from source"
    print(f"  ✓ vector_file='dacs-v0.1-happy-path.json' → BYTE-EQUAL ({len(source)} chars)")

    np_ = idx.get_conformance_vectors(vector_file="dacs-v0.1-negative-paths.json")
    source = (repo_path / "conformance/vectors/dacs-v0.1-negative-paths.json").read_text(encoding="utf-8")
    assert np_["file_bytes"] == source
    print(f"  ✓ vector_file='dacs-v0.1-negative-paths.json' → BYTE-EQUAL ({len(source)} chars)")

    # Path-traversal guards — all three lookup args
    bad_vf = idx.get_conformance_vectors(vector_file="../fixtures/attestation-bundle-htlc9.json")
    assert "error" in bad_vf and "traversal" in bad_vf["error"], \
        f"vector_file traversal not refused: {bad_vf}"
    bad_abs = idx.get_conformance_vectors(vector_file="/etc/passwd")
    assert "error" in bad_abs and "relative" in bad_abs["error"]
    bad_fx = idx.get_conformance_vectors(fixture_path="../../../etc/passwd")
    assert "error" in bad_fx and "traversal" in bad_fx["error"]
    print("  ✓ path-traversal guards: vector_file= ../fixtures, /abs, fixture_path= ../../etc — all refused")

    # Mutual exclusion across all three
    both = idx.get_conformance_vectors(vector_id="x", vector_file="y", fixture_path="z")
    assert "error" in both and "at most one" in both["error"]
    print("  ✓ mutual exclusion: 3-arg combo refused")

    # vector_id case lookup (a real case from MANIFEST)
    case = idx.get_conformance_vectors(vector_id="cd1-trailing-zeros")
    assert case.get("vector_id") == "cd1-trailing-zeros"
    assert case["manifest_entry"]["id"] == "cd1-trailing-zeros"
    # Field discipline: passthrough verbatim
    assert {"id", "area", "spec", "summary", "status", "reason", "want"} <= set(case["manifest_entry"].keys())
    print("  ✓ vector_id='cd1-trailing-zeros' passes through all 7 MANIFEST fields verbatim")

    # ── Negative paths ─────────────────────────────────────────────────
    assert "error" in idx.get_rule("HTLC-99")
    assert "error" in idx.get_section("99.99.99")
    assert "error" in idx.get_artifact_schema("Nonexistent")
    assert "error" in idx.get_conformance_vectors(vector_id="nonexistent-id")
    assert "error" in idx.get_conformance_vectors(vector_file="nonexistent.json")
    assert "error" in idx.get_conformance_vectors(fixture_path="nonexistent.json")

    # ── SKIP_PREFIXES respected — no DACS-N rules, no ERC/EIP/etc. ─────
    external = {"AP", "CAIP", "DACS", "EIP", "ERC", "HTTP", "IEEE", "L",
                "NAICS", "P", "RE", "UTF"}
    for rid, rule in idx.rules.items():
        assert rule.family not in external, \
            f"SKIP_PREFIXES family leaked: {rid} family={rule.family}"

    # ── Schema set ─────────────────────────────────────────────────────
    expected_schemas = {
        "IdentityBundle", "BundleClaim", "Listing", "Recipe", "VerifyResult",
        "AttestationRef", "AgreementDocument", "CommitmentRecord",
        "PaymentRailRef", "SettlementEvidence", "AttestationBundle",
    }
    missing = expected_schemas - set(idx.schemas.keys())
    assert not missing, f"missing schemas: {missing}"

    print()
    print(BAR)
    print(" ALL PHASE 2/3/4 ASSERTIONS PASSED ".center(78, "═"))
    print(BAR)
    return 0


if __name__ == "__main__":
    sys.exit(main())
