# Source mapping

The public prompts derive from a DACS PR Review Executor automation used by `mj-deving` on 13 September 2026. The source automation is private configuration, so this repository contains the reusable contract rather than private paths, identity-bound authority, or restricted review state.

The preservation rule for this extraction is strict: retain the source Goal, Success criteria, evidence model, stage model, concrete-repair contract, authority boundaries, stopping conditions, and output schema. Change a source rule only when public reuse or cross-runtime execution requires it, and record the reason here.

## Preserved contract

| Source section | Public result |
|---|---|
| Goal | Same progression through eligible review stages, exact-candidate evidence, ownership, disclosure, and reconstructible state |
| Success criteria | Same per-change record, isolated mutation scope, public/restricted consistency, run-versus-objective distinction, plus the already-required concrete-repair rule made explicit |
| Stage workflow | Same design-draft, design-review, design-approved, implementation, acceptance-review, ready-to-merge, and done distinctions in the DACS prompt |
| Discovery and execution | Same lean gate, live refresh, trigger, exact revision, ownership, isolation, reconciliation, and named-oracle requirements |
| Review findings | Same exact location, requirement, evidence, compatible repair, expected behavior, and executable acceptance check |
| Stop rules | Same authority, drift, disclosure, ownership, parallel-join, merge, release, deployment, and automation boundaries |
| Output | Same compact run and overall-status fields with the named human generalized to the current reviewer or owner |
| Queue reconstruction | The source goal implied exhaustive progress, but its addressing, phase, and readiness predicates were not operationalized. The public prompts add a complete directed-change matrix with recorded classification evidence. |
| Iteration | The source bounded a dispatch cohort without mechanically requiring another discovery pass after reconciliation. The public prompts add a fixed-point loop and forbid treating one lane or batch as overall completion. |
| Lean gate | The source allowed a recent no-delta comparison. The public prompts still require a fresh identity, addressing, revision, and reconciliation classification before `NO ACTION`. |

## Necessary deviations

| Source behavior | Public form | Reason |
|---|---|---|
| Hard-coded `mj-deving` identity | Currently authenticated reviewer | Another contributor cannot inherit a person's identity or review scope. |
| Private workspace and absolute local paths | Active authoritative checkout and runtime-local state | Local paths are private, machine-specific, and unusable by another reviewer. |
| Personal standing authorization dated 2026-09-13 | Safe read-only and unset-reviewer defaults; another allowed effect records the current authenticated user's direct local binding to an exact provider login | Authorization cannot be transferred through a shared prompt or silently follow changed credentials. |
| Mandatory access to all visible private vulnerability reports before any action | Restricted surfaces admitted per candidate; missing access holds that lane | Public reviewers may lack private-report access. Missing restricted access must not disclose content or create a false global pass. |
| Beads and private ISA required by name | Project-declared task ledger and owning specification when present | These are local coordination implementations rather than universal review semantics. |
| Fixed local lock path | Runtime-provided unique lock; serial fallback | Lock paths and concurrency primitives belong to the runtime adapter. |
| Fixed three-lane worker and cohort-join machinery | Parallel lanes only with isolation and one reconciliation owner; serial fallback | Other runtimes expose different worker and state-isolation primitives. |
| Named private review levels and installed tools | Current repository policy and strongest available required capability | A public prompt cannot claim another reviewer has locally installed skills or private policy. Missing required checks still produce `HOLD`. |
| Codex-specific scheduler self-pause | Configured completion action with explicit current runtime authority, state readback, and report-only fallback | Scheduler mutation is runtime-specific and cannot be granted by copied configuration text. |
| `Marius action` output field | Required human action or none | The reusable prompt must address its actual operator. |
| Source shorthand `two maintainer approvals` | Two distinct assigned-contributor approvals on the same revision, followed by final steward approval | The live #398 governance text uses contributor-account approvals and records the steward decision separately. |
| Scattered source checks plus live discussion #400 guidance | One explicit review-quality section | Consolidates exact-head, missing-oracle, concrete-repair, disclosure, duplicate-review, approval-rate, unsupported-finding, dirty-base, stacked-parent, and outcome-over-tool-trace rules. |
| Repeated procedural explanation | A 50–80-line ideal-state contract with the same asserted gates | Keeps the pasteable automation readable without weakening authority, state, repair, reconciliation, or completion semantics. |
| Queue, review, and publication collapsed into one result | DACS file identified as an optional full-queue adapter with explicit run limits and separated snapshot, findings, checks, disposition, publication, and usage records | Incorporates the proposed steward direction in discussion #400 without prematurely restructuring the prototype or running the deferred eval suite. |
| Ambiguous completion with held lanes | Overall completion requires both `ACTIONABLE = 0` and `HOLD = 0` | An unresolved hold keeps the overall objective in progress and keeps the scheduler able to observe its trigger. |
| Readiness mixed with prior disposition | Terminal classifications run before readiness | An existing exact-revision disposition is evidence of completed review scope, not a blocker. |
| Repair detail attached only to `CHANGES_REQUESTED` | Full repair chain for every accepted finding that asks for a change | DACS uses actionable `COMMENT` findings for some integration and evidence conditions. |
| Open oracle hold looked like a terminal disposition | A disposition with a named uncleared hold remains `HOLD` | A comment can record a valid review result while deliberately leaving one deciding condition open. |
| Non-submit execution could re-enter the same lane | Read-only and draft results become a per-run `HOLD` after one pass | No provider-visible disposition exists to terminate the lane when the configured effect forbids submission. |
| Configured write effect could survive an identity downgrade in loop logic | Derive `EFFECTIVE_EFFECT` after identity, provenance, and permission checks | Every action and stopping decision must use the safe runtime result rather than the configured value alone. |
| Portable placeholders repeated in operational clauses | Placeholders occur only in the configuration block; the body names configured keys | Adopters can configure one block without leaving unresolved operational tokens. |
| Candidate-only terminal disposition | Bind prior dispositions to the recorded integration-base revision as well as candidate and scope | A stable candidate can become stale when its required integration base advances. |
| Unbounded portable effect value | Closed portable vocabulary with read-only and unset-reviewer defaults | Runtimes need interoperable write semantics and a fail-safe default rather than an arbitrary authority string. |
| Open hold could disappear after its provider request cleared | Retain the reviewer's named uncleared hold in the directed inventory until evidence is evaluated or coordination explicitly withdraws it | Monitoring ownership must survive the provider-side request transition that the review itself can cause. |
| Hold-only recheck could override integration-base drift | Give base drift priority and require a full assessment against the new exact base | Evidence that closes an old hold cannot validate behavior in a changed integration context. |
| Empty directed inventory could self-pause while authors were repairing reviewed changes | Separate the executable directed inventory from an enrolled-queue completion view and require every enrolled entry to be globally terminal before self-pause | Reviewer idle is not queue completion; later revisions still need discovery when re-addressed. |
| DACS monitoring scope could be unset in a standalone copy | Fix DACS completion monitoring to all current #398 entries; require a nonempty configured scope in the portable prompt | Global completion must not pass vacuously over an undefined enrollment set. |
| Provider review could look terminal before required coordination/readback completed | Require reconciled external effects and use a reconciliation-only actionable lane | Partial or unknown writes need live readback and bounded completion, not duplicate review or blind retry. |
| Read-only and draft deduplication lasted only one invocation | Persist an exact reviewer/candidate/scope/base/effect hold key across scheduled runs | An unchanged candidate should not be repeatedly reassessed or notify merely because a new scheduler run began. |

## Deliberately deferred

- Public evaluation fixtures and a runner remain follow-up work in [DACS-Standard discussion #400](https://github.com/DACS-Agent-commerce/DACS-Standard/discussions/400).
- Repeated `pass^k` trials and the proposed 16-run calibration remain evaluation methodology rather than runtime executor behavior.
- Additional runtime adapters require evidence from the same public fixtures before support is claimed.
- This prototype does not alter DACS normative text, issue #398 policy, repository permissions, or any scheduler.
