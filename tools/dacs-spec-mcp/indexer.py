"""DACS spec indexer — multi-file ingestion.

Reads the modular DACS spec set (CORE + 5 stage modules + 4 companions) from a
pinned local checkout and builds three indexes:

1. Section tree — chapter ancestry resolves the duplicate §6/§7 namespaces
   (front-matter "## N. …" vs Chapter wrapper "## Chapter N — …") AND the
   new dual-residence: §A and ch.12/13/14 each appear as a redirect stub in
   CORE.md and a full body in the companion file. Both registered, tagged
   kind="redirect" or kind="body"; dacs_get_section returns all matches in
   SPEC_FILES concatenation order, caller decides.
2. Rule index — line-bounded extraction of inline `(XX-N)` definitions per
   SPEC-STYLE.md §"micro-template". Adopts upstream's authoritative regex set
   and SKIP_PREFIXES wholesale; rule_family() correctly attributes hyphenated
   families (RAV-R, VP-R) by stripping trailing digits then trailing hyphen.
3. Schema index — bare-fence (no lang tag) blocks whose first content line
   matches `^type \\w+ = \\{`. Each schema BONDS the trailing canonical-hash /
   domain-separator / signing-payload prose that follows the closing fence.

No paraphrase. All tool results are verbatim spec slices. Per-line (file,
line_in_file) provenance is preserved through the concat so error messages
and citations can still point to the source file.
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


# Mirror of scripts/specsource.py @ b3646aa SPEC_FILES, verbatim per
# vendor-pin discipline. Authored order: Core first, then five stage
# modules, then CORE back-matter companions (§A, ch.12, ch.13, ch.14).
# PRIMER.md (non-normative root) and spec/PROFILE.md (excluded upstream)
# are deliberately NOT in this list — we mirror the normative surface
# upstream's own validators operate on, nothing more.
# Upstream concat is "\n".join(parts); we match exactly and additionally
# retain per-line (file, line_in_file) provenance which specsource doesn't.
SPEC_FILES: List[str] = [
    "spec/CORE.md",
    "spec/DACS-1-IDENTIFY.md",
    "spec/DACS-2-VET.md",
    "spec/DACS-3-NEGOTIATE.md",
    "spec/DACS-4-SETTLE.md",
    "spec/DACS-5-VERIFY.md",
    "spec/DEMOS-MAPPING.md",
    "spec/THREAT-MODEL.md",
    "spec/GLOSSARY.md",
    "spec/CONFORMANCE-PLAN.md",
]


# Mirror of scripts/validate_rule_ids.py @ b3646aa, verbatim. These are
# non-DACS standards / namespaces that share the rule-id regex shape but
# are NOT normative conformance rules:
#   AP (e.g. AP2 — Google Agent Payments protocol stub)
#   CAIP (chain-agnostic improvement proposal refs)
#   DACS (stage references — DACS-1..DACS-5)
#   EIP / ERC (Ethereum standards)
#   HTTP (RFC 7231 / 9110 codes)
#   IEEE, NAICS (external standards)
#   L (e.g. L2PS substrate reference)
#   P (Polkadot / RFC P-codes)
#   RE (reference-equivalence markers)
#   SR (substrate requirements — surfaced separately via the §5
#       capability table, not via inline cites)
#   UTF (UTF-N codepoint references)
SKIP_PREFIXES = {
    "AP", "CAIP", "DACS", "EIP", "ERC", "HTTP", "IEEE", "L",
    "NAICS", "P", "RE", "SR", "UTF",
}


def rule_family(rule_id: str) -> str:
    """Strip trailing digits, then trailing hyphen.

    Mirror of scripts/validate_rule_ids.py @ b3646aa::rule_family. Examples:
        "RAV-R1"   -> "RAV-R"
        "VP-R4"    -> "VP-R"
        "HTLC-10"  -> "HTLC"
        "CF-2"     -> "CF"
        "AP2"      -> "AP"      (caught by SKIP_PREFIXES)
        "DACS-1"   -> "DACS"    (caught by SKIP_PREFIXES)
    """
    return re.sub(r"\d+$", "", rule_id).rstrip("-")


# Section numbering: numeric form (## 11.1, ### 11.1.1, etc.)
SECTION_NUMBER_RE = re.compile(r"^(\d+(?:\.\d+)*)\.?\s+")

# NEW : letter-prefixed sections — CORE back-matter §A / §B.1..7 / §C
# Matches "A. ", "B.1 ", "B.7 ", "C. " — captures the letter-form section ref.
LETTER_SECTION_NUMBER_RE = re.compile(r"^([A-Z](?:\.\d+)*)\.?\s+")

HEADING_RE = re.compile(r"^(#{1,4})\s+(.*?)\s*$")
CHAPTER_RE = re.compile(r"^Chapter\s+(\d+)\s+—\s+(.+)$")

# REPLACED : upstream's authoritative inline-definition regex.
# Wider family pattern admits hyphenated families (RAV-R, VP-R) and digit-
# embedded family names; SKIP_PREFIXES + rule_family() handle attribution.
# Mirror of scripts/validate_rule_ids.py @ b3646aa::PAREN_DEF_RE, verbatim.
RULE_LABEL_RE = re.compile(r"\((?P<rule_id>[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)?-?\d+)\)")

# a rule's definition can land in multiple forms across
# multiple files — paren-def "(XX-N)" at one site, word-def "Rule XX-N" /
# "rule XX-N" at others (typically a canonical hoist target like CORE §B.x).
# Mirror of scripts/validate_rule_ids.py @ b3646aa::RULE_WORD_DEF_RE,
# verbatim. Prose cross-references (bare "CF-4 governs..." without "rule"
# prefix or surrounding parens) are NOT def-sites and are NOT indexed.
RULE_WORD_DEF_RE = re.compile(
    r"\b[Rr]ule\s+(?P<rule_id>[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)?-?\d+)\b"
)

TYPE_HEADER_RE = re.compile(r"^type\s+(\w+)\s*=\s*\{")
BARE_FENCE_RE = re.compile(r"^```\s*$")
ANY_FENCE_RE = re.compile(r"^```")

# NEW : redirect stub detection. CORE.md carries 3-paragraph cross-
# ref stubs for §A / ch.12 / ch.13 / ch.14 whose first non-empty body line
# starts with "Moved to **[<Companion>](<Companion>.md)**". Used to tag
# Section.kind = "redirect" vs "body".
REDIRECT_LINE_RE = re.compile(r"^Moved to \*\*\[[^\]]+\]\([^)]+\)\*\*")


@dataclass
class Section:
    number: Optional[str]
    title: str
    level: int
    chapter: Optional[str]       # raw chapter heading (e.g. "Chapter 6 — DACS-1: Identify")
    start_line: int              # 1-indexed in CONCAT stream (inclusive)
    end_line: int                # 1-indexed in CONCAT stream (exclusive)
    heading_line: str = ""
    full_text: str = ""
    # per-file provenance (preserved through SPEC_FILES concat).
    file: str = ""               # repo-relative path, e.g. "spec/CORE.md"
    line_in_file: int = 0        # 1-indexed in the source file
    # dual-residence tagging — "redirect" stub (CORE) or "body"
    # (companion file); regular single-residence sections are "body".
    kind: str = "body"


@dataclass
class RuleSite:
    """One def-form occurrence of a rule. Per Phase-2 follow-up: a rule can
    have multiple sites — paren-def "(XX-N)" at one location, word-def
    "Rule XX-N" / "rule XX-N" at another (e.g. CORE §B.x hoist target).
    Mirrors option-(c) section policy: caller decides between sites."""
    form: str                    # "paren-def" | "word-def" | "table-row" (SR)
    file: str                    # repo-relative path
    line: int                    # 1-indexed in CONCAT stream
    line_in_file: int            # 1-indexed in source file
    section_number: Optional[str]
    section_title: Optional[str]
    line_text: str               # the full line containing the def-form marker


@dataclass
class Rule:
    """A rule indexed by its rule_id. Phase-2 follow-up: a rule may have
    multiple def-form sites (paren-def + one-or-more word-defs across files
    when a rule is hoisted). All sites are stored; get_rule returns them in
    concatenation order, mirroring the section dual-residence policy."""
    rule_id: str
    family: str
    is_conformance: bool
    sites: List[RuleSite] = field(default_factory=list)

    @property
    def primary_site(self) -> Optional[RuleSite]:
        """Pick a primary site for legacy single-site consumers (search,
        list_rule_family snippets). Prefer paren-def (per SPEC-STYLE.md the
        load-bearing definition form); fall back to first word-def; finally
        first site."""
        if not self.sites:
            return None
        for s in self.sites:
            if s.form == "paren-def":
                return s
        for s in self.sites:
            if s.form == "word-def":
                return s
        return self.sites[0]

    @property
    def primary_text(self) -> str:
        s = self.primary_site
        return s.line_text if s else ""

    @property
    def primary_section_number(self) -> Optional[str]:
        s = self.primary_site
        return s.section_number if s else None

    @property
    def primary_section_title(self) -> Optional[str]:
        s = self.primary_site
        return s.section_title if s else None

    @property
    def primary_line(self) -> int:
        s = self.primary_site
        return s.line if s else 0


@dataclass
class Schema:
    name: str
    fence_block: str
    bonded_prose: str
    section_number: Optional[str]
    section_title: Optional[str]
    start_line: int              # 1-indexed in CONCAT stream
    end_line: int
    # per-file provenance
    file: str = ""
    line_in_file: int = 0


class DacsIndex:
    def __init__(self, repo_path: Path):
        self.repo_path = Path(repo_path).resolve()
        # multi-file ingestion. spec_paths is the ordered list of
        # SPEC_FILES; spec_path is retained (singular) as the back-compat
        # property pointing at the FIRST file (CORE.md) for stamping
        # (format_response surfaces the full list via spec_paths separately).
        self.spec_paths: List[Path] = [self.repo_path / rel for rel in SPEC_FILES]
        self.spec_path: Path = self.spec_paths[0]
        self.changelog_path = self.repo_path / "CHANGELOG.md"

        # conformance manifest + vectors / fixtures roots.
        self.manifest_path = self.repo_path / "conformance" / "MANIFEST.json"
        self.vectors_root = self.repo_path / "conformance" / "vectors"
        self.fixtures_root = self.repo_path / "conformance" / "fixtures"
        self.manifest: Optional[Dict[str, Any]] = None

        self.commit: str = "unknown"
        self.version: str = "unknown"
        self.version_date: str = "unknown"

        # Concatenated line stream + per-line provenance.
        self.lines: List[str] = []
        # provenance[i] = (relative_file_path, 1-indexed line_in_file) for self.lines[i]
        self.provenance: List[Tuple[str, int]] = []

        self.sections: List[Section] = []
        self.rules: Dict[str, Rule] = {}
        self.schemas: Dict[str, Schema] = {}

    # ---------- build ----------

    def build(self) -> None:
        missing = [p for p in self.spec_paths if not p.is_file()]
        if missing:
            raise FileNotFoundError(
                f"DACS spec files missing under {self.repo_path}: "
                + ", ".join(str(p.relative_to(self.repo_path)) for p in missing)
            )
        # Build the concat stream + per-line provenance. Mirror specsource's
        # single-newline join (no extra blank line between files) so a grep
        # against the concat is byte-identical to upstream's spec_text().
        all_lines: List[str] = []
        prov: List[Tuple[str, int]] = []
        for i, abs_path in enumerate(self.spec_paths):
            rel = str(abs_path.relative_to(self.repo_path))
            file_lines = abs_path.read_text(encoding="utf-8").splitlines()
            # specsource uses "\n".join(parts); a file ending with no trailing
            # newline therefore produces a concat where the next file's first
            # line immediately follows. We mirror that: just splitlines per
            # file, no separator added.
            for j, ln in enumerate(file_lines):
                all_lines.append(ln)
                prov.append((rel, j + 1))
        self.lines = all_lines
        self.provenance = prov

        self._read_commit()
        self._read_version()
        self._index_sections()
        self._index_rules()
        self._index_schemas()
        self._load_manifest()

    def _load_manifest(self) -> None:
        """read conformance/MANIFEST.json if present. Cached as-is
        for verbatim passthrough — no field reshaping."""
        if not self.manifest_path.is_file():
            self.manifest = None
            return
        try:
            self.manifest = json.loads(
                self.manifest_path.read_text(encoding="utf-8")
            )
        except (json.JSONDecodeError, OSError):
            self.manifest = None

    def _read_commit(self) -> None:
        try:
            res = subprocess.run(
                ["git", "-C", str(self.repo_path), "rev-parse", "HEAD"],
                capture_output=True, text=True, check=True,
            )
            self.commit = res.stdout.strip()
        except (subprocess.CalledProcessError, FileNotFoundError):
            pass

    def _read_version(self) -> None:
        if not self.changelog_path.is_file():
            return
        cl_re = re.compile(r"^##\s*\[(?P<ver>\d+\.\d+)\]\s*—\s*(?P<date>\d{4}-\d{2}-\d{2})")
        for line in self.changelog_path.read_text(encoding="utf-8").splitlines():
            m = cl_re.match(line)
            if m:
                self.version = m.group("ver")
                self.version_date = m.group("date")
                return

    def _index_sections(self) -> None:
        headings: List[Dict[str, Any]] = []
        current_chapter: Optional[str] = None

        for i, line in enumerate(self.lines):
            m = HEADING_RE.match(line)
            if not m:
                continue
            level = len(m.group(1))
            raw_title = m.group(2)

            chapter_match = CHAPTER_RE.match(raw_title)
            num_match = SECTION_NUMBER_RE.match(raw_title)
            letter_match = LETTER_SECTION_NUMBER_RE.match(raw_title)
            number: Optional[str] = None
            title = raw_title

            if chapter_match:
                number = chapter_match.group(1)
            elif num_match:
                number = num_match.group(1)
                title = raw_title[num_match.end():].lstrip(" -—")
            elif letter_match:
                # Letter-prefixed sections: §A, §B.1, §C, etc. (CORE back-matter).
                number = letter_match.group(1)
                title = raw_title[letter_match.end():].lstrip(" -—")

            # Update chapter context only on level-2 headings.
            # Any non-"Chapter N" level-2 resets to None so back-matter
            # "## References" doesn't inherit Chapter 14.
            if level == 2:
                current_chapter = raw_title if chapter_match else None

            headings.append({
                "line": i,
                "level": level,
                "raw_title": raw_title,
                "number": number,
                "title": title,
                "chapter": current_chapter,
            })

        for idx, h in enumerate(headings):
            start = h["line"]
            end = headings[idx + 1]["line"] if idx + 1 < len(headings) else len(self.lines)
            # detect redirect stub. CORE.md carries 3-paragraph
            # cross-ref stubs for §A and ch.12/13/14; their first non-empty
            # body line starts with "Moved to **[<Companion>](...)**".
            kind = "body"
            for j in range(start + 1, min(end, start + 6)):
                bl = self.lines[j].strip()
                if not bl:
                    continue
                if REDIRECT_LINE_RE.match(bl):
                    kind = "redirect"
                break  # first non-empty body line decides
            # Provenance for the heading line.
            file_rel, line_in_file = self.provenance[start]
            self.sections.append(Section(
                number=h["number"],
                title=h["title"],
                level=h["level"],
                chapter=h["chapter"],
                start_line=start + 1,
                end_line=end + 1,
                heading_line=self.lines[start],
                full_text="\n".join(self.lines[start:end]),
                file=file_rel,
                line_in_file=line_in_file,
                kind=kind,
            ))

    def _section_for_line(self, line_1indexed: int) -> Optional[Section]:
        # Deepest (largest-level) section whose [start, end) covers the line.
        best: Optional[Section] = None
        for sec in self.sections:
            if sec.start_line <= line_1indexed < sec.end_line:
                if best is None or sec.level > best.level:
                    best = sec
        return best

    def _index_rules(self) -> None:
        """Phase-2 follow-up: index ALL def-form sites per rule_id.

        For each line: collect paren-def sites (PAREN_DEF_RE) and word-def
        sites (RULE_WORD_DEF_RE). For each match, attribute the family via
        rule_family(); skip if family is in SKIP_PREFIXES. Register a
        RuleSite per (rule_id, form, file, line) tuple. Multiple sites for
        the same rule_id accumulate; sites are ordered by concat-stream
        line (which equals SPEC_FILES order + in-file order).

        Prose cross-references (bare "CF-4" without a "rule" prefix or
        surrounding parens) are NOT def-form sites and are deliberately
        not indexed.
        """
        # (rule_id, form, file, line) tuples already registered — dedup key
        seen: set = set()

        for line_idx, line in enumerate(self.lines):
            sites_on_line: List[Dict[str, Any]] = []

            # paren-def sites
            if "(" in line:
                for m in RULE_LABEL_RE.finditer(line):
                    rid = m.group("rule_id")
                    fam = rule_family(rid)
                    if fam in SKIP_PREFIXES:
                        continue
                    sites_on_line.append({
                        "rule_id": rid, "family": fam, "form": "paren-def",
                    })

            # word-def sites
            if "ule " in line:  # quick pre-filter for "rule "/"Rule "
                for m in RULE_WORD_DEF_RE.finditer(line):
                    rid = m.group("rule_id")
                    fam = rule_family(rid)
                    if fam in SKIP_PREFIXES:
                        continue
                    sites_on_line.append({
                        "rule_id": rid, "family": fam, "form": "word-def",
                    })

            if not sites_on_line:
                continue

            file_rel, line_in_file = self.provenance[line_idx]
            sec = self._section_for_line(line_idx + 1)

            for s in sites_on_line:
                rid = s["rule_id"]
                key = (rid, s["form"], file_rel, line_idx + 1)
                if key in seen:
                    continue
                seen.add(key)

                # Create Rule entry on first sight; subsequent sites append
                # to the existing Rule's sites list.
                if rid not in self.rules:
                    self.rules[rid] = Rule(
                        rule_id=rid,
                        family=s["family"],
                        # Per upstream SKIP_PREFIXES, SR is substrate-
                        # requirement (not conformance). Everything that
                        # gets here is a conformance rule.
                        is_conformance=True,
                        sites=[],
                    )

                self.rules[rid].sites.append(RuleSite(
                    form=s["form"],
                    file=file_rel,
                    line=line_idx + 1,
                    line_in_file=line_in_file,
                    section_number=sec.number if sec else None,
                    section_title=sec.title if sec else None,
                    line_text=line,
                ))

        # SR-1..SR-5 come from the §5 capability table, not inline cites.
        # The table is canonical; inline (SR-N) references are pointers.
        self._enrich_sr_from_table()

    def _enrich_sr_from_table(self) -> None:
        # | SR-N | Capability | Description | Used by |
        table_re = re.compile(
            r"^\|\s*(SR-[1-5])\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|"
        )
        for i, line in enumerate(self.lines):
            m = table_re.match(line)
            if not m:
                continue
            sr_id = m.group(1)
            file_rel, line_in_file = self.provenance[i]
            sec = self._section_for_line(i + 1)
            section_number = sec.number if sec and sec.number else "5"
            section_title = sec.title if sec and sec.title else "Substrate capabilities"
            site = RuleSite(
                form="table-row",
                file=file_rel,
                line=i + 1,
                line_in_file=line_in_file,
                section_number=section_number,
                section_title=section_title,
                line_text=line,
            )
            if sr_id not in self.rules:
                self.rules[sr_id] = Rule(
                    rule_id=sr_id,
                    family="SR",
                    is_conformance=False,
                    sites=[],
                )
            self.rules[sr_id].sites.append(site)

    def _index_schemas(self) -> None:
        i = 0
        n = len(self.lines)
        while i < n:
            line = self.lines[i]
            if not BARE_FENCE_RE.match(line):
                # If lang-tagged fence (spec doesn't use any in SPECIFICATION.md
                # but be safe), skip to its closer.
                if ANY_FENCE_RE.match(line):
                    j = i + 1
                    while j < n and not ANY_FENCE_RE.match(self.lines[j]):
                        j += 1
                    i = j + 1
                    continue
                i += 1
                continue

            fence_start = i
            j = i + 1
            content: List[str] = []
            while j < n and not ANY_FENCE_RE.match(self.lines[j]):
                content.append(self.lines[j])
                j += 1
            fence_end = j  # closing fence line, or end of file
            fence_block = "\n".join(self.lines[fence_start:fence_end + 1])

            # Capture (type_name, line_within_fence) so each schema points at its
            # own `type Name = {` line rather than the shared fence opener.
            type_headers: List[Dict[str, Any]] = []
            for offset, c in enumerate(content):
                tm = TYPE_HEADER_RE.match(c.strip())
                if tm:
                    type_headers.append({
                        "name": tm.group(1),
                        # +1 to skip the opening fence; +1 for 1-indexed lines
                        "line": fence_start + 1 + offset + 1,
                    })

            if type_headers:
                bond_start = fence_end + 1
                bond_end = bond_start
                max_bond = 30  # empirical cap; bonded prose is short
                while bond_end < n and (bond_end - bond_start) < max_bond:
                    bl = self.lines[bond_end]
                    if HEADING_RE.match(bl):
                        break
                    if ANY_FENCE_RE.match(bl):
                        break
                    bond_end += 1
                # trim trailing blank lines
                while bond_end > bond_start and self.lines[bond_end - 1].strip() == "":
                    bond_end -= 1
                bonded_prose = "\n".join(self.lines[bond_start:bond_end])

                sec = self._section_for_line(fence_start + 1)
                for th in type_headers:
                    if th["name"] in self.schemas:
                        continue
                    # th["line"] is 1-indexed in concat; provenance index is 0-indexed
                    th_line_concat0 = th["line"] - 1
                    file_rel, line_in_file = self.provenance[th_line_concat0]
                    self.schemas[th["name"]] = Schema(
                        name=th["name"],
                        fence_block=fence_block,
                        bonded_prose=bonded_prose,
                        section_number=sec.number if sec else None,
                        section_title=sec.title if sec else None,
                        start_line=th["line"],
                        end_line=bond_end,
                        file=file_rel,
                        line_in_file=line_in_file,
                    )

            i = fence_end + 1

    # ---------- tool surfaces ----------

    def search(self, query: str) -> List[Dict[str, Any]]:
        q = query.strip()
        if not q:
            return []
        q_norm = q.lstrip("§").strip()
        q_lower = q_norm.lower()
        hits: List[Dict[str, Any]] = []

        # Exact rule-id hit (highest priority).
        upper = q_norm.upper()
        if upper in self.rules:
            r = self.rules[upper]
            hits.append({
                "kind": "rule",
                "anchor": r.rule_id,
                "section": f"§{r.primary_section_number}" if r.primary_section_number else None,
                "chapter": r.primary_section_title,
                "score": 100,
                "snippet": r.primary_text[:240],
                "site_count": len(r.sites),
            })

        # Exact section-number hit.
        for sec in self.sections:
            if sec.number and sec.number == q_norm:
                hits.append({
                    "kind": "section",
                    "anchor": f"§{sec.number}",
                    "section": sec.number,
                    "chapter": sec.chapter,
                    "score": 95,
                    "snippet": sec.heading_line,
                })

        # Exact schema-name hit (case-sensitive — type names are TitleCase).
        if q in self.schemas:
            sch = self.schemas[q]
            hits.append({
                "kind": "schema",
                "anchor": sch.name,
                "section": f"§{sch.section_number}" if sch.section_number else None,
                "chapter": sch.section_title,
                "score": 90,
                "snippet": (sch.bonded_prose or sch.fence_block)[:240],
            })

        # Substring scoring across titles / rule text / schema bodies.
        terms = [t for t in re.split(r"\W+", q_lower) if len(t) >= 3]
        if terms:
            for sec in self.sections:
                hay = (sec.title + " " + sec.heading_line).lower()
                score = sum(10 for t in terms if t in hay)
                if score:
                    hits.append({
                        "kind": "section",
                        "anchor": f"§{sec.number}" if sec.number else sec.title,
                        "section": sec.number,
                        "chapter": sec.chapter,
                        "score": score,
                        "snippet": sec.heading_line,
                    })
            for r in self.rules.values():
                # Search across ALL site texts (a hoisted word-def in CORE
                # may contain different keywords than the paren-def site).
                hay_parts = [s.line_text for s in r.sites]
                hay = " ".join(hay_parts).lower()
                score = sum(3 for t in terms if t in hay)
                if score:
                    hits.append({
                        "kind": "rule",
                        "anchor": r.rule_id,
                        "section": f"§{r.primary_section_number}" if r.primary_section_number else None,
                        "chapter": r.primary_section_title,
                        "score": score,
                        "snippet": r.primary_text[:240],
                        "site_count": len(r.sites),
                    })
            for sch in self.schemas.values():
                hay = (sch.fence_block + " " + sch.bonded_prose).lower()
                score = sum(3 for t in terms if t in hay)
                if score:
                    hits.append({
                        "kind": "schema",
                        "anchor": sch.name,
                        "section": f"§{sch.section_number}" if sch.section_number else None,
                        "chapter": sch.section_title,
                        "score": score,
                        "snippet": (sch.bonded_prose or sch.fence_block)[:240],
                    })

        # De-dupe by (kind, anchor), keep highest score; deterministic sort.
        best: Dict[Any, Dict[str, Any]] = {}
        for h in hits:
            key = (h["kind"], h["anchor"])
            if key not in best or h["score"] > best[key]["score"]:
                best[key] = h
        ranked = sorted(best.values(), key=lambda h: (-h["score"], str(h["anchor"])))
        return ranked[:25]

    def get_section(self, ref: str, chapter_hint: Optional[str] = None) -> Dict[str, Any]:
        """Return ALL sections matching ref in SPEC_FILES concatenation order,
        each tagged with kind ("body" | "redirect") + (file, line_in_file)
        provenance. No merging, no preference logic — the
        caller decides between redirect stub and companion body.

        chapter_hint is retained as an OPTIONAL filter that narrows the
        candidate set without forcing a single return.
        """
        ref_norm = ref.strip().lstrip("§").strip()
        candidates = [s for s in self.sections if s.number == ref_norm]
        if not candidates:
            return {"error": f"No section found with ref '{ref}'", "matches": []}

        if chapter_hint:
            hint = chapter_hint.lower().strip()
            if "front" in hint or "front-matter" in hint or hint == "fm":
                filtered = [s for s in candidates if s.chapter is None]
            else:
                filtered = [s for s in candidates
                            if s.chapter and hint in s.chapter.lower()]
            if filtered:
                candidates = filtered

        # Already in concat order — _index_sections appends as it scans.
        return {
            "ref": f"§{ref_norm}",
            "match_count": len(candidates),
            "matches": [self._section_to_dict(s) for s in candidates],
        }

    def _section_to_dict(self, sec: Section) -> Dict[str, Any]:
        return {
            "ref": f"§{sec.number}" if sec.number else sec.title,
            "title": sec.title,
            "chapter": sec.chapter,
            "level": sec.level,
            "kind": sec.kind,                     # "body" | "redirect"
            "file": sec.file,                     # provenance
            "line_in_file": sec.line_in_file,     # provenance
            "start_line": sec.start_line,         # concat-stream
            "end_line": sec.end_line,             # concat-stream
            "text": sec.full_text,
        }

    def get_rule(self, rule_id: str) -> Dict[str, Any]:
        """Phase-2 follow-up: return ALL def-form sites for the rule_id, in
        SPEC_FILES concatenation order, each tagged with form / file /
        line_in_file / § / section_title. Mirrors option-(c) section policy.
        """
        rid = rule_id.strip().upper()
        if rid not in self.rules:
            return {"error": f"No rule found with id '{rule_id}'"}
        r = self.rules[rid]
        # Sites already accumulate in concat order (line index ascends);
        # explicit sort is a defensive belt-and-suspenders.
        sites = sorted(r.sites, key=lambda s: s.line)
        return {
            "rule_id": r.rule_id,
            "family": r.family,
            "is_conformance": r.is_conformance,
            "site_count": len(sites),
            "sites": [
                {
                    "form": s.form,
                    "file": s.file,
                    "line_in_file": s.line_in_file,
                    "line": s.line,
                    "section": f"§{s.section_number}" if s.section_number else None,
                    "section_title": s.section_title,
                    "line_text": s.line_text,
                }
                for s in sites
            ],
            "note": (
                "Substrate requirement — not a conformance rule."
                if r.family == "SR" else ""
            ),
        }

    def list_rule_family(self, prefix: str) -> List[Dict[str, Any]]:
        p = prefix.strip().upper()
        members: List[Dict[str, Any]] = []
        for r in self.rules.values():
            if r.family == p:
                # one-liner: first sentence of the primary site's line.
                one = r.primary_text.split(".")[0].strip()
                if one and not one.endswith("."):
                    one += "."
                members.append({
                    "rule_id": r.rule_id,
                    "section": f"§{r.primary_section_number}" if r.primary_section_number else None,
                    "section_title": r.primary_section_title,
                    "line": r.primary_line,
                    "one_liner": one[:240],
                    "site_count": len(r.sites),
                })

        def sort_key(m: Dict[str, Any]) -> Any:
            rid = m["rule_id"]
            tail = rid.split("-")[-1]
            num = re.match(r"([CR]?)(\d+)", tail)
            if num:
                return (num.group(1), int(num.group(2)))
            return ("", 0)

        members.sort(key=sort_key)
        return members

    def get_artifact_schema(self, name: str) -> Dict[str, Any]:
        if name not in self.schemas:
            return {"error": f"No schema found with name '{name}'"}
        sch = self.schemas[name]
        return {
            "name": sch.name,
            "section": f"§{sch.section_number}" if sch.section_number else None,
            "section_title": sch.section_title,
            "file": sch.file,                  # provenance
            "line_in_file": sch.line_in_file,  # provenance
            "start_line": sch.start_line,      # concat-stream
            "end_line": sch.end_line,
            "fence_block": sch.fence_block,
            "bonded_prose": sch.bonded_prose,
        }

    def _pick_body(self, candidates: List[Section]) -> Optional[Section]:
        """When a section ref resolves to a redirect stub AND a companion body,
        prefer the body. get_conformance_plan is the single tool that asserts
        this preference (get_section returns both, by design)."""
        bodies = [s for s in candidates if s.kind == "body"]
        if bodies:
            return bodies[0]
        return candidates[0] if candidates else None

    def get_conformance_plan(self, stage: Optional[str] = None) -> Dict[str, Any]:
        if stage:
            ref = stage.strip().lstrip("§").strip()
            candidates = [s for s in self.sections if s.number == ref]
            if not candidates:
                return {"error": f"No conformance section found at '{stage}'"}
            sec = self._pick_body(candidates)
            return {
                "stage": f"§{sec.number}",
                "title": sec.title,
                "kind": sec.kind,
                "file": sec.file,
                "line_in_file": sec.line_in_file,
                "text": sec.full_text,
            }
        ch14 = [s for s in self.sections if s.number == "14"]
        if not ch14:
            return {"error": "Chapter 14 not found"}
        sec = self._pick_body(ch14)
        return {
            "stage": "§14 (full)",
            "title": sec.title,
            "kind": sec.kind,
            "file": sec.file,
            "line_in_file": sec.line_in_file,
            "text": sec.full_text,
        }


    # ---------- conformance vectors  ----------

    # The MANIFEST.json `cases` array is the master vector list; entries
    # don't carry per-id file paths and individual vector files don't have
    # 1:1 id-to-file naming, so the derivable host file for every case
    # is conformance/vectors/golden.json (the aggregate per upstream
    # layout). This is "derivable from repo layout" per the Phase B
    # amendment: we add file_path only where derivable, and never invent.
    _VECTORS_HOST_FILE_RELATIVE = "conformance/vectors/golden.json"

    def get_conformance_vectors(
        self,
        vector_id: Optional[str] = None,
        vector_file: Optional[str] = None,
        fixture_path: Optional[str] = None,
    ) -> Dict[str, Any]:
        """four call shapes.

        - No args → list every MANIFEST case verbatim with manifest_metadata
          attached, PLUS a vector_files list of every standalone .json file
          under conformance/vectors/ (lifecycle-vector reachability).
          file_path is the only field added beyond MANIFEST contents; the
          vector_files entries carry filename + size_bytes only (no
          invented metadata).
        - vector_id="X" → return the manifest case for id X verbatim + the
          host vector file bytes verbatim. No slicing — caller decides.
        - vector_file="X.json" : fetch a standalone file under
          conformance/vectors/ jailed via path-traversal guard. Use for
          dacs-v0.1-happy-path.json, dacs-v0.1-negative-paths.json, and
          any sub-directory file (e.g. examples/identity-bundle.json) —
          files that aren't MANIFEST cases.
        - fixture_path="X" → resolve X relative to conformance/fixtures/
          with the same guard pattern (jailed to fixtures root); return
          the fixture's file bytes verbatim.

        All three positional-lookup args are mutually exclusive — at most
        one may be set per call.

        Every shape carries the standard version stamp via format_response.
        Field discipline: every MANIFEST field passes through verbatim,
        never invented. file_path is the only field added.
        """
        # Mutual exclusion across all three positional-lookup args.
        set_args = [
            name for name, val in (
                ("vector_id", vector_id),
                ("vector_file", vector_file),
                ("fixture_path", fixture_path),
            )
            if val is not None
        ]
        if len(set_args) > 1:
            return {
                "error": (
                    "specify at most one of vector_id / vector_file / "
                    f"fixture_path, got: {set_args}"
                )
            }

        if fixture_path is not None:
            return self._get_fixture(fixture_path)
        if vector_file is not None:
            return self._get_vector_file(vector_file)
        if vector_id is not None:
            return self._get_vector_by_id(vector_id)
        return self._list_vectors()

    def _list_standalone_vector_files(self) -> List[Dict[str, Any]]:
        """Enumerate every .json file under conformance/vectors/ recursively,
        filename relative to vectors/ + size in bytes. Used by the no-arg
        response so lifecycle vectors (which aren't MANIFEST cases) are
        discoverable. No invented metadata — just (filename, size_bytes)."""
        if not self.vectors_root.is_dir():
            return []
        files: List[Dict[str, Any]] = []
        for p in sorted(self.vectors_root.rglob("*.json")):
            if not p.is_file():
                continue
            files.append({
                "filename": str(p.relative_to(self.vectors_root)),
                "size_bytes": p.stat().st_size,
            })
        return files

    def _list_vectors(self) -> Dict[str, Any]:
        vector_files = self._list_standalone_vector_files()
        if not self.manifest or not isinstance(self.manifest.get("cases"), list):
            return {
                "error": "conformance/MANIFEST.json not present or malformed",
                "cases": [],
                "vector_files": vector_files,
            }
        manifest_metadata = {
            k: v for k, v in self.manifest.items() if k != "cases"
        }
        host_exists = self.vectors_root.joinpath("golden.json").is_file()
        cases_out: List[Dict[str, Any]] = []
        for c in self.manifest["cases"]:
            if not isinstance(c, dict):
                continue
            entry = dict(c)  # verbatim copy — don't mutate the manifest
            if host_exists:
                entry["file_path"] = self._VECTORS_HOST_FILE_RELATIVE
            cases_out.append(entry)
        return {
            "manifest_metadata": manifest_metadata,
            "case_count": len(cases_out),
            "cases": cases_out,
            "vector_files": vector_files,
        }

    def _get_vector_by_id(self, vector_id: str) -> Dict[str, Any]:
        if not self.manifest or not isinstance(self.manifest.get("cases"), list):
            return {"error": "conformance/MANIFEST.json not present or malformed"}
        matches = [
            c for c in self.manifest["cases"]
            if isinstance(c, dict) and c.get("id") == vector_id
        ]
        if not matches:
            return {"error": f"No vector with id '{vector_id}'"}
        case = dict(matches[0])  # verbatim copy
        host_path = self.vectors_root / "golden.json"
        if host_path.is_file():
            case["file_path"] = self._VECTORS_HOST_FILE_RELATIVE
            file_bytes = host_path.read_text(encoding="utf-8")
        else:
            file_bytes = None
        return {
            "vector_id": vector_id,
            "manifest_entry": case,
            "file_path": self._VECTORS_HOST_FILE_RELATIVE if host_path.is_file() else None,
            "file_bytes": file_bytes,
        }

    def _get_vector_file(self, vector_file: str) -> Dict[str, Any]:
        """path-traversal-guarded fetch under conformance/vectors/.
        Jailed to vectors_root; refuses absolute paths and anything resolving
        outside the jail. Same guard shape as _get_fixture (jailed elsewhere)."""
        if not isinstance(vector_file, str) or not vector_file:
            return {"error": "vector_file must be a non-empty string"}
        base = self.vectors_root.resolve()
        if not base.is_dir():
            return {"error": "conformance/vectors/ not present"}
        candidate = Path(vector_file)
        if candidate.is_absolute():
            return {"error": f"vector_file must be relative: '{vector_file}'"}
        try:
            target = (base / candidate).resolve()
        except (OSError, RuntimeError) as e:
            return {"error": f"vector_file resolution failed: {e}"}
        try:
            target.relative_to(base)
        except ValueError:
            return {
                "error": (
                    f"path traversal refused: '{vector_file}' resolves outside "
                    "conformance/vectors/"
                )
            }
        if not target.is_file():
            return {"error": f"vector file not found at 'conformance/vectors/{vector_file}'"}
        rel_to_repo = str(target.relative_to(self.repo_path))
        return {
            "vector_file": vector_file,
            "file_path": rel_to_repo,
            "size_bytes": target.stat().st_size,
            "file_bytes": target.read_text(encoding="utf-8"),
        }

    def _get_fixture(self, fixture_path: str) -> Dict[str, Any]:
        """Path-traversal-guarded fixture fetch. fixture_path is resolved
        relative to conformance/fixtures/; any resolved path that escapes
        the fixtures root is refused."""
        if not isinstance(fixture_path, str) or not fixture_path:
            return {"error": "fixture_path must be a non-empty string"}
        base = self.fixtures_root.resolve()
        if not base.is_dir():
            return {"error": "conformance/fixtures/ not present"}
        # Reject absolute paths and parent-walk separators outright; defense in depth.
        candidate = Path(fixture_path)
        if candidate.is_absolute():
            return {"error": f"fixture_path must be relative: '{fixture_path}'"}
        try:
            target = (base / candidate).resolve()
        except (OSError, RuntimeError) as e:
            return {"error": f"fixture_path resolution failed: {e}"}
        try:
            target.relative_to(base)
        except ValueError:
            return {
                "error": (
                    f"path traversal refused: '{fixture_path}' resolves outside "
                    "conformance/fixtures/"
                )
            }
        if not target.is_file():
            return {"error": f"fixture not found at 'conformance/fixtures/{fixture_path}'"}
        rel_to_repo = str(target.relative_to(self.repo_path))
        return {
            "fixture_path": fixture_path,
            "file_path": rel_to_repo,
            "file_bytes": target.read_text(encoding="utf-8"),
        }


def format_response(index: DacsIndex, payload: Any) -> Dict[str, Any]:
    """Wrap every tool response with the stamping envelope.

    spec_path retained (= first SPEC_FILES entry, CORE.md) for
    back-compat; spec_paths is the authoritative ordered list of normative
    source files this index was built from.
    """
    return {
        "dacs_version": index.version,
        "version_date": index.version_date,
        "commit": index.commit,
        "spec_path": str(index.spec_path),
        "spec_paths": [str(p) for p in index.spec_paths],
        "result": payload,
    }
