# Codex adapter

This adapter maps the Agent Review Contract onto Codex. It changes runtime mechanics, not review semantics.

## Interactive use

1. Open the target repository as a Codex project, but load governing `AGENTS.md` and policy from the trusted integration-base revision. Treat candidate changes to those files as reviewable artifacts until integrated.
2. Start a task with either the complete DACS Codex automation or a configured copy of the portable prompt.
3. State the intended effect explicitly: read-only review, draft review body, or submission to a named review surface.
4. Keep GitHub authentication only in the trusted provider control-plane step. Run candidate-controlled checks in a separate credential-free sandbox with network denied and writes confined to its isolated candidate workspace. The prompt carries no credential or permission grant.

## Scheduled use

Codex scheduled tasks can run a recurring prompt against a selected local project. For DACS, configure `AUTHORIZED_EFFECT` and `AUTHORIZED_REVIEWER` from the authenticated user's direct local instruction, then paste the full contents of [`../prompts/dacs-codex-automation.md`](../prompts/dacs-codex-automation.md) as the task instruction. Paste no README, adapter, delivery, or notification text around it. Keep scheduling and notification preferences outside the prompt so changing cadence does not fork the review contract.

The DACS prompt explicitly requires the scheduled run to authenticate the current reviewer, call `get_goal`, call `create_goal` when none is active, and verify the resulting objective before review work. In interfaces exposing only slash commands, the equivalent operator action is `/goal <objective>`. This follows [Codex's durable-goal model](https://learn.chatgpt.com/use-cases/follow-goals): one objective, one verifiable stopping condition, and progress across turns. The Goal covers the currently executable directed-review frontier, not the open-ended global queue; its completion therefore does not imply global queue completion.

For a scheduled executor, add these runtime bindings:

- one local project containing the authoritative checkout;
- the schedule and notification policy;
- a runtime-owned cursor or prior task state for lean comparisons and cross-run read-only/draft hold deduplication;
- a no-progress livelock guard and an incremental-spend limit, never a review-count budget;
- a unique executor lock when concurrent runs are possible; and
- explicit authority for any review or coordination write the task may perform.

Codex project instructions belong in `AGENTS.md`; project policy outranks the reusable prompt. See the official Codex documentation for [scheduled tasks](https://learn.chatgpt.com/docs/automations), [custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md), and [code review](https://learn.chatgpt.com/docs/code-review).

## Capability mapping

| Contract capability | Codex mapping |
|---|---|
| Repository and policy discovery | Project checkout, shell, repository `AGENTS.md` |
| Provider state and review submission | GitHub CLI, GitHub integration, or an installed provider tool |
| Exact-candidate isolation | Git worktree or another isolated checkout |
| Candidate command isolation | Fresh immutable exact-pin snapshot per oracle, read-only inputs, credential-free sandbox, network denied, separate ephemeral outputs |
| Focused verification | Repository-native test and validation commands |
| Security review | Available Codex Security capability when the admitted lane requires it |
| Parallel review lanes | Native agents only when isolated state and one reconciliation owner are available |
| Run lock and cursor | Runtime-local state outside the contributed repository |
| Self-pause | Codex scheduled-task update only when the task has explicit authority for that automation |

Capability names and availability vary by installation. A missing required capability produces the contract's `HOLD` disposition with the exact next oracle. It never becomes an assumed pass.

## Adapter acceptance

A Codex run satisfies this adapter when it:

- loads the intended project instructions;
- loads governing instructions from the trusted integration-base revision and reviews candidate instruction changes only as artifacts;
- isolates candidate-controlled commands from provider credentials and the trusted submission step;
- verifies reviewed-input identity before and after each oracle and discards results from mutated inputs;
- verifies repository and reviewer identity before a write;
- downgrades to read-only when the authenticated provider identity does not exactly match the configured authorized reviewer;
- binds every review to an immutable candidate revision;
- inventories every change directed to the authenticated reviewer before selecting a lane;
- separately inventories every entry in the executor's enrolled monitoring scope for global completion without authorizing work on non-directed entries;
- persists non-submit results across runs using the assessment-input fingerprint plus current admission and hold state;
- reconciles partial or unknown external writes from live destination state without rerunning review oracles or blindly retrying writes;
- holds reconciliation when the effective effect does not authorize the missing write, naming the required authorization or human update as its trigger;
- rebuilds that inventory after each batch and continues while `ACTIONABLE > 0`;
- binds the native Goal to the verified authenticated reviewer, initializes or resumes it through native Goal operations, verifies it by readback, and completes it only after a refreshed inventory proves `ACTIONABLE = 0` with no reconciliation due;
- applies no candidate, full-review, refresh-cycle, or elapsed-time work cap, and uses the no-progress guard only for identical non-advancing state;
- records which checks actually executed;
- records the canonical assessment-input fingerprint, including the assessed stage, with every disposition, compares admission state immediately before submission, and reconciles publication results separately;
- supplies the full concrete-repair chain for every requested change;
- reads external writes back from the provider;
- reports the overall objective as `IN PROGRESS` while any `HOLD` or globally nonterminal enrolled entry remains, treats reviewer idle and `ALREADY_DISPOSITIONED` as insufficient for global completion, and applies self-pause only after `ACTIONABLE = 0`, `HOLD = 0`, and every enrolled entry is `DONE` or `WITHDRAWN_OR_SUPERSEDED`; and
- keeps scheduler state distinct from overall review completion.
