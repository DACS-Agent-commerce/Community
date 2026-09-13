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
            "recorded assessment-input fingerprint equals the current assessment-input fingerprint",
            "Integration-base drift takes priority over named-hold handling",
            "A disposition that leaves a named hold open is not terminal",
            "remains in the directed inventory until its clearing evidence is evaluated",
            "full assessment against the new",
            "Only while the recorded integration base remains current",
            "even if its provider review request has cleared",
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
            "keep the overall objective `IN PROGRESS`",
            "after this global completion predicate is proven",
            "terminal conditions before review readiness",
            "Only the remaining directed changes enter readiness classification",
            "Separately build an enrolled-queue inventory",
            "completion evidence only and does not authorize work on a non-directed entry",
            "enrolled-queue completion view",
            "NO ACTION (CURRENT REVIEWER IDLE)",
            "That is not overall completion",
            "every entry in the enrolled-queue inventory is globally terminal",
            "`ALREADY_DISPOSITIONED` is terminal for the current review scope but remains globally nonterminal",
            "reviewer-idle state",
            "every required external write and readback for that disposition is reconciled",
            "required external write or readback not yet reconciled",
            "remains directed until reconciliation completes",
            "`ACTIONABLE` for reconciliation only",
            "never blindly retry an unknown write",
            "do not rerun review oracles or duplicate a confirmed write",
            "When the missing write is unauthorized",
            "required authorization or human update",
            "persist a bounded runtime-local hold record keyed by the assessment-input fingerprint plus current admission and hold state",
            "required-oracle/check and named clearing evidence",
            "Carry it across scheduled runs",
            "those inputs remain unchanged",
            "stay quiet",
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

    def test_prompts_separate_assessment_admission_and_publication_state(self):
        for prompt in PROMPTS:
            text = prompt.read_text(encoding="utf-8")
            with self.subTest(prompt=prompt.name):
                self.assertIn("canonical assessment-input fingerprint", text)
                self.assertIn("admission fingerprint", text)
                self.assertIn("before submission", text)
                self.assertIn("addressed review condition and scope", text)
                self.assertIn("candidate and integration-base pins", text)
                self.assertIn("`EFFECTIVE_EFFECT`", text)
                self.assertIn("required-oracle/check and named clearing evidence", text)
                self.assertIn("Exclude trigger, stage, owner, publication, coordination-write, and readback results", text)
                self.assertIn("current trigger, stage, and owner", text)
                self.assertIn("Every disposition records the assessment fingerprint", text)
                self.assertIn("rebuild and compare the admission fingerprint", text)
                self.assertIn("assessment-input drift", text)
                self.assertIn("reconcile", text)
                self.assertIn("withdrawal", text.lower())

        portable = PROMPTS[1].read_text(encoding="utf-8")
        self.assertNotIn("new addressed request supplies a distinct review scope", portable)

    def test_every_terminal_and_duplicate_path_uses_current_fingerprint(self):
        expected_counts = {
            "dacs-codex-automation.md": 2,
            "portable-review-contract.md": 3,
        }
        predicate = "recorded assessment-input fingerprint equals the current assessment-input fingerprint"
        for prompt in PROMPTS:
            text = prompt.read_text(encoding="utf-8")
            with self.subTest(prompt=prompt.name):
                self.assertEqual(expected_counts[prompt.name], text.count(predicate))

    def test_result_records_persist_and_read_back_assessment_fingerprint(self):
        for prompt in PROMPTS:
            text = prompt.read_text(encoding="utf-8")
            with self.subTest(prompt=prompt.name):
                self.assertIn("persisted assessment-input fingerprint", text)
                self.assertIn("readback including persisted fingerprint", text)

    def test_general_output_fails_closed_for_restricted_detail(self):
        for prompt in PROMPTS:
            text = prompt.read_text(encoding="utf-8")
            with self.subTest(prompt=prompt.name):
                self.assertIn("detailed", text)
                self.assertIn("destination is verified as the authorized unrestricted or restricted venue", text)
                self.assertIn("general task result and notification contain only disclosure-safe", text)
                self.assertIn("no restricted identifiers, revisions, locations, evidence, repairs, digests, or links", text)

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
        self.assertIn("`ALL_CURRENT_398_ENTRIES`", text)

    def test_dacs_automation_stays_compact(self):
        lines = PROMPTS[0].read_text(encoding="utf-8").splitlines()
        self.assertGreaterEqual(len(lines), 50)
        self.assertLessEqual(len(lines), 80)

    def test_dacs_adapter_has_explicit_run_limits_and_result_layers(self):
        text = PROMPTS[0].read_text(encoding="utf-8")
        for key in (
            "MAX_CANDIDATES_PER_RUN",
            "MAX_REFRESH_CYCLES",
            "MAX_ELAPSED_MINUTES",
            "MAX_INCREMENTAL_SPEND",
            "snapshot {",
            "findings[] {",
            "checks[] {",
            "disposition {",
            "publication {",
            "usage {",
        ):
            self.assertIn(key, text)

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
        self.assertIn("`MONITORING_SCOPE`: `{{NONEMPTY_COORDINATION_SCOPE}}`", text)
        self.assertIn("never treat an empty derived view as global completion", text)

    def test_portable_executor_has_finite_run_limits(self):
        text = PROMPTS[1].read_text(encoding="utf-8")
        for binding in (
            "`MAX_CANDIDATES_PER_RUN`: `3`",
            "`MAX_REFRESH_CYCLES`: `3`",
            "`MAX_ELAPSED_MINUTES`: `45`",
            "`MAX_INCREMENTAL_SPEND`: `0`",
        ):
            self.assertIn(binding, text)
        self.assertIn(
            "never exceed any configured candidate, refresh-cycle, elapsed-time, or incremental-spend limit",
            text,
        )
        self.assertIn("RUN LIMIT REACHED", text)
        self.assertIn("next executable lane", text)

    def test_portable_terminal_state_has_an_explicit_live_evidence_binding(self):
        text = PROMPTS[1].read_text(encoding="utf-8")
        self.assertIn(
            "`TERMINAL_STATE`: `{{TERMINAL_STAGE_AND_REQUIRED_LIVE_EVIDENCE}}`",
            text,
        )
        self.assertIn(
            "every required live-evidence condition defined by the configured `TERMINAL_STATE`",
            text,
        )

    def test_portable_self_pause_requires_runtime_authority_and_readback(self):
        text = PROMPTS[1].read_text(encoding="utf-8")
        self.assertIn("explicit current runtime authority", text)
        self.assertIn("monitoring scope is closed to future entries", text)
        self.assertIn("verified reliable external wake-up mechanism", text)
        self.assertIn("remain active and quiet while polling on schedule", text)
        self.assertIn("read the resulting state back", text)
        self.assertIn("fall back to report-only", text)
        self.assertIn("does not itself grant scheduler-mutation authority", text)

    def test_dacs_open_queue_cannot_self_pause_without_wake_path(self):
        text = PROMPTS[0].read_text(encoding="utf-8")
        self.assertIn("#398 is explicitly closed to future entries", text)
        self.assertIn("reliable external wake-up mechanism is verified", text)
        self.assertIn("Otherwise remain active and quiet while polling on schedule", text)

    def test_docs_preserve_global_completion_boundary(self):
        for relative in ("README.md", "adapters/codex.md"):
            text = (ROOT / relative).read_text(encoding="utf-8")
            with self.subTest(document=relative):
                self.assertIn("enrolled", text)
                self.assertIn("`DONE`", text)
                self.assertIn("`WITHDRAWN_OR_SUPERSEDED`", text)
                self.assertIn("reviewer idle", text)

    def test_docs_bind_holds_to_complete_fingerprint(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        adapter = (ROOT / "adapters" / "codex.md").read_text(encoding="utf-8")
        for text in (readme, adapter):
            self.assertIn("assessment-input fingerprint", text)
        self.assertIn("required-oracle/check and clearing-evidence state", readme)
        self.assertIn("Trigger, stage, owner, publication, coordination-write, and readback results are excluded", readme)
        self.assertIn("admission fingerprint adds trigger, stage, and owner", readme)
        self.assertIn("effects are reconciled separately", readme)
        self.assertIn("reconciles publication results separately", adapter)

    def test_read_only_allows_only_bounded_executor_state(self):
        for prompt in PROMPTS:
            text = prompt.read_text(encoding="utf-8")
            with self.subTest(prompt=prompt.name):
                self.assertIn("bounded runtime-local lock, cursor, and hold state", text)
                self.assertIn("never permits an external or project mutation", text)

    def test_candidate_commands_are_isolated_from_provider_credentials(self):
        for prompt in PROMPTS:
            text = prompt.read_text(encoding="utf-8")
            with self.subTest(prompt=prompt.name):
                self.assertIn("each deciding oracle", text)
                self.assertIn("fresh immutable exact-pin snapshot", text)
                self.assertIn("isolated credential-free sandbox", text)
                self.assertIn("reviewed inputs are read-only", text)
                self.assertIn("provider credentials absent", text)
                self.assertIn("network denied", text)
                self.assertIn("separate ephemeral directory", text)
                self.assertIn("Verify reviewed-input identity before and after every oracle", text)
                self.assertIn("discard any result if inputs changed", text)
                self.assertIn("separate trusted control-plane step", text)

    def test_candidate_instructions_cannot_govern_their_own_review(self):
        for prompt in PROMPTS:
            text = prompt.read_text(encoding="utf-8")
            with self.subTest(prompt=prompt.name):
                self.assertIn("trusted integration-base revision", text)
                self.assertIn("Candidate changes to instruction or policy files", text)
                self.assertIn("gain no governing authority before integration", text)

    def test_prompts_preserve_discussion_400_runtime_rules(self):
        required = (
            "Never optimize for approval rate",
            "Do not invent",
            "Tool sequences are evidence",
            "dirty against",
            "stacked on",
            "deciding oracle did not run",
            "recorded assessment-input fingerprint equals",
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
