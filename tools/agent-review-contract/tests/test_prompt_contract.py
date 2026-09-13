from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
PROMPTS = (
    ROOT / "prompts" / "dacs-codex-automation.md",
    ROOT / "prompts" / "portable-review-contract.md",
)


class PromptContractTest(unittest.TestCase):
    def test_prompts_require_exhaustive_fixed_point_execution(self):
        required = (
            "## State reconstruction and fixed-point execution",
            "directed to the current reviewer",
            "current stage",
            "readiness classification",
            "directed-by evidence",
            "classification | existing disposition",
            "integration-base revision | classification",
            "recorded integration-base revision is still current",
            "Integration-base drift takes priority over named-hold handling",
            "A disposition that leaves a named hold open is not terminal",
            "remains in the directed inventory until its clearing evidence is evaluated",
            "full assessment against the new",
            "Only while the recorded integration base remains current",
            "even if its provider review request has cleared",
            "classify the lane as `HOLD` for the rest of this run",
            "carry that evidence into every inventory rebuild in this run",
            "do not reassess the unchanged revision",
            "Derive `EFFECTIVE_EFFECT` after those checks",
            "configured submit effect downgraded to effective read-only",
            "never the configured value alone",
            "ACTIONABLE",
            "ALREADY_DISPOSITIONED",
            "WITHDRAWN_OR_SUPERSEDED",
            "rebuild the entire inventory",
            "Completing one review or one batch is never evidence",
            "ACTIONABLE = 0",
            "HOLD = 0",
            "If `HOLD > 0`",
            "overall objective as `IN PROGRESS`",
            "only after the complete predicate is proven",
            "terminal conditions before review readiness",
            "Only the remaining directed changes enter readiness classification",
        )

        for prompt in PROMPTS:
            text = prompt.read_text(encoding="utf-8")
            with self.subTest(prompt=prompt.name):
                for phrase in required:
                    self.assertIn(phrase, text)

    def test_prompts_preserve_concrete_repair_contract(self):
        required = (
            "violated requirement",
            "supporting evidence",
            "compatible repair approach",
            "expected post-fix behavior",
            "executable acceptance checks",
        )

        for prompt in PROMPTS:
            text = prompt.read_text(encoding="utf-8")
            with self.subTest(prompt=prompt.name):
                for phrase in required:
                    self.assertIn(phrase, text)

    def test_dacs_prompt_uses_current_approval_roles(self):
        text = PROMPTS[0].read_text(encoding="utf-8")
        self.assertIn("distinct assigned contributor accounts", text)
        self.assertIn("steward's final design approval", text)
        self.assertIn("steward's final pull-request approval", text)
        self.assertNotIn("maintainer design approvals", text)

    def test_dacs_artifact_is_named_as_complete_codex_automation(self):
        dacs = ROOT / "prompts" / "dacs-codex-automation.md"
        self.assertTrue(dacs.is_file())
        self.assertFalse((ROOT / "prompts" / "dacs-review-executor.md").exists())
        self.assertTrue(
            dacs.read_text(encoding="utf-8").startswith(
                "# DACS Codex Review Automation"
            )
        )
        text = dacs.read_text(encoding="utf-8")
        self.assertIn("`AUTHORIZED_EFFECT`: `READ_ONLY`", text)
        self.assertIn("`AUTHORIZED_REVIEWER`: `UNSET`", text)
        self.assertIn("`SUBMIT_REVIEWS_AND_PUBLIC_SAFE_398_UPDATES`", text)
        self.assertIn("require exact equality with `AUTHORIZED_REVIEWER`", text)

    def test_dacs_comment_findings_require_repair_chain(self):
        text = PROMPTS[0].read_text(encoding="utf-8")
        self.assertIn(
            "including an actionable `COMMENT` or `CHANGES_REQUESTED` finding",
            text,
        )

    def test_portable_placeholders_are_confined_to_configuration(self):
        text = PROMPTS[1].read_text(encoding="utf-8")
        operational_contract = text.split("## Role", maxsplit=1)[1]
        self.assertNotIn("{{", operational_contract)
        self.assertNotIn("}}", operational_contract)

    def test_portable_effect_vocabulary_is_closed_and_safe_by_default(self):
        text = PROMPTS[1].read_text(encoding="utf-8")
        self.assertIn("`AUTHORIZED_EFFECT`: `READ_ONLY`", text)
        self.assertIn("`AUTHORIZED_REVIEWER`: `UNSET`", text)
        self.assertIn("`SUBMIT_REVIEWS`", text)
        self.assertIn("`SUBMIT_REVIEWS_AND_PUBLIC_COORDINATION`", text)

    def test_portable_self_pause_requires_runtime_authority_and_readback(self):
        text = PROMPTS[1].read_text(encoding="utf-8")
        self.assertIn("explicit current runtime authority", text)
        self.assertIn("read the resulting state back", text)
        self.assertIn("fall back to report-only", text)
        self.assertIn("does not itself grant scheduler-mutation authority", text)

    def test_prompts_preserve_discussion_400_runtime_rules(self):
        required = (
            "Never optimize for approval rate",
            "Do not invent",
            "Tool sequences are evidence",
            "dirty against",
            "stacked on",
            "deciding oracle did not run",
            "same pin and scope",
            "review completion distinct",
            "Public leakage",
        )

        for prompt in PROMPTS:
            text = prompt.read_text(encoding="utf-8")
            with self.subTest(prompt=prompt.name):
                for phrase in required:
                    self.assertIn(phrase, text)

    def test_markdown_tables_have_consistent_column_counts(self):
        for document in ROOT.rglob("*.md"):
            expected = None
            for line_number, line in enumerate(
                document.read_text(encoding="utf-8").splitlines(), start=1
            ):
                if line.startswith("|") and line.endswith("|"):
                    columns = line.count("|") - 1
                    if expected is None:
                        expected = columns
                    self.assertEqual(
                        expected,
                        columns,
                        f"{document.name}:{line_number} has an inconsistent table row",
                    )
                else:
                    expected = None


if __name__ == "__main__":
    unittest.main()
