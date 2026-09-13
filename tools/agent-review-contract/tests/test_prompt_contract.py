from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
PROMPTS = (
    ROOT / "prompts" / "dacs-review-executor.md",
    ROOT / "prompts" / "portable-review-contract.md",
)


class PromptContractTest(unittest.TestCase):
    def test_prompts_require_exhaustive_fixed_point_execution(self):
        required = (
            "## State reconstruction and fixed-point execution",
            "directed to the current reviewer",
            "current stage",
            "review-ready",
            "directed-by evidence",
            "ACTIONABLE",
            "ALREADY_DISPOSITIONED",
            "WITHDRAWN_OR_SUPERSEDED",
            "rebuild the entire inventory",
            "Completing one review or one batch is never evidence",
            "ACTIONABLE = 0",
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
