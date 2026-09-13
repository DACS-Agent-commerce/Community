# Codex adapter

This adapter maps the Agent Review Contract onto Codex. It changes runtime mechanics, not review semantics.

## Interactive use

1. Open the target repository as a Codex project so its `AGENTS.md` instructions are in scope.
2. Start a task with either the complete DACS Codex automation or a configured copy of the portable prompt.
3. State the intended effect explicitly: read-only review, draft review body, or submission to a named review surface.
4. Keep GitHub authentication and repository permissions in the Codex environment. The prompt carries no credential or permission grant.

## Scheduled use

Codex scheduled tasks can run a recurring prompt against a selected local project. For DACS, configure `AUTHORIZED_EFFECT` and `AUTHORIZED_REVIEWER` from the authenticated user's direct local instruction, then paste the full contents of [`../prompts/dacs-codex-automation.md`](../prompts/dacs-codex-automation.md) as the task instruction. Paste no README, adapter, delivery, or notification text around it. Keep scheduling and notification preferences outside the prompt so changing cadence does not fork the review contract.

For a scheduled executor, add these runtime bindings:

- one local project containing the authoritative checkout;
- the schedule and notification policy;
- a runtime-owned cursor or prior task state for lean comparisons and cross-run read-only/draft hold deduplication;
- a unique executor lock when concurrent runs are possible; and
- explicit authority for any review or coordination write the task may perform.

Codex project instructions belong in `AGENTS.md`; project policy outranks the reusable prompt. See the official Codex documentation for [scheduled tasks](https://learn.chatgpt.com/docs/automations), [custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md), and [code review](https://learn.chatgpt.com/docs/code-review).

## Capability mapping

| Contract capability | Codex mapping |
|---|---|
| Repository and policy discovery | Project checkout, shell, repository `AGENTS.md` |
| Provider state and review submission | GitHub CLI, GitHub integration, or an installed provider tool |
| Exact-candidate isolation | Git worktree or another isolated checkout |
| Focused verification | Repository-native test and validation commands |
| Security review | Available Codex Security capability when the admitted lane requires it |
| Parallel review lanes | Native agents only when isolated state and one reconciliation owner are available |
| Run lock and cursor | Runtime-local state outside the contributed repository |
| Self-pause | Codex scheduled-task update only when the task has explicit authority for that automation |

Capability names and availability vary by installation. A missing required capability produces the contract's `HOLD` disposition with the exact next oracle. It never becomes an assumed pass.

## Adapter acceptance

A Codex run satisfies this adapter when it:

- loads the intended project instructions;
- verifies repository and reviewer identity before a write;
- downgrades to read-only when the authenticated provider identity does not exactly match the configured authorized reviewer;
- binds every review to an immutable candidate revision;
- inventories every change directed to the authenticated reviewer before selecting a lane;
- separately inventories every entry in the executor's enrolled monitoring scope for global completion without authorizing work on non-directed entries;
- persists non-submit results across runs using the contract's reviewer, candidate, scope, integration-base, effect, and governing contract/policy-revision key;
- reconciles partial or unknown external writes from live destination state without rerunning review oracles or blindly retrying writes;
- rebuilds that inventory after each batch and continues while `ACTIONABLE > 0`;
- records which checks actually executed;
- supplies the full concrete-repair chain for every requested change;
- reads external writes back from the provider;
- reports the overall objective as `IN PROGRESS` while any `HOLD` or globally nonterminal enrolled entry remains, treats reviewer idle and `ALREADY_DISPOSITIONED` as insufficient for global completion, and applies self-pause only after `ACTIONABLE = 0`, `HOLD = 0`, and every enrolled entry is `DONE` or `WITHDRAWN_OR_SUPERSEDED`; and
- keeps scheduler state distinct from overall review completion.
