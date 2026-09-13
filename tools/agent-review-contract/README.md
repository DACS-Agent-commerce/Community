# Agent Review Contract

Agent Review Contract is a pair of reusable prompts for evidence-bound pull-request review. The DACS Codex automation is the drop-in task instruction for reviewers working from the public DACS coordinator queue. The portable prompt keeps the same review semantics and exposes the small set of project and runtime bindings another agent environment must supply.

## DACS surface

This tool supports the contributor-review workflow around [DACS-Standard](https://github.com/DACS-Agent-commerce/DACS-Standard), including the public [coordinator review queue](https://github.com/DACS-Agent-commerce/DACS-Standard/issues/398). It does not implement a DACS protocol module or change conformance semantics.

## Conformance status

`prototype`: these prompts support contributor review and evaluation. They have not been promoted into DACS conformance vectors and do not certify a reviewer, model, runtime, pull request, or implementation.

## Choose a prompt

- [`prompts/dacs-codex-automation.md`](./prompts/dacs-codex-automation.md) is the complete, compact 50–80-line Codex task instruction for DACS-Standard review automation. Its safe copy-paste defaults are read-only with no authorized reviewer.
- [`prompts/portable-review-contract.md`](./prompts/portable-review-contract.md) is the project-neutral template. Replace its configuration values, then use it in any agent environment with repository read access and an authorized review-submission path.
- [`adapters/codex.md`](./adapters/codex.md) maps either prompt onto Codex projects, tasks, and scheduled tasks.
- [`SOURCE_MAPPING.md`](./SOURCE_MAPPING.md) records every material change from the source DACS automation and why it was necessary for public reuse.

Both prompts preserve the same core rule: a requested change includes the exact candidate and location, violated requirement, supporting evidence, compatible repair, expected post-fix behavior, and executable acceptance checks. A reviewer that identifies a defect and leaves the author to rediscover the repair has not completed the review contract.

They also require fixed-point execution: identify every change currently directed to the authenticated reviewer, classify its stage and review readiness, process a safe batch, refresh the complete inventory, and continue until `ACTIONABLE = 0`. A separate enrolled-queue view prevents reviewer idle from masquerading as completion. Overall completion and self-pause additionally require `HOLD = 0` and every enrolled entry to be globally `DONE` or `WITHDRAWN_OR_SUPERSEDED`; a clean individual review, `ALREADY_DISPOSITIONED` scope, idle reviewer, or completed batch is not enough.

The review-quality rules adopt the public guidance proposed in discussion #400: score the complete disposition rather than approval rate, reject unsupported findings, require exact-candidate pins and runnable repairs, hold when a deciding oracle is missing, stop duplicate reviews on unchanged candidates, handle dirty or stacked candidates without imaginary integration, and separate review completion from merge or release. Restricted findings stay in their authorized venue.

## Copy the DACS Codex automation

The automation text is the full content of [`prompts/dacs-codex-automation.md`](./prompts/dacs-codex-automation.md). The file contains the complete review contract and two operator settings, `AUTHORIZED_EFFECT` and `AUTHORIZED_REVIEWER`. The README and Codex adapter are setup documentation and are not part of the scheduled task instruction.

1. Select a local Codex project whose canonical remote is `DACS-Agent-commerce/DACS-Standard`.
2. Keep `AUTHORIZED_EFFECT: READ_ONLY` and `AUTHORIZED_REVIEWER: UNSET`, or directly authorize Codex in the local creation instruction to set one other allowed effect and bind `AUTHORIZED_REVIEWER` to your exact authenticated provider login.
3. Paste the configured complete automation file into the scheduled task's instruction field.
4. Choose the schedule, model, and notification policy in Codex. Delivery or notification steps, for example a chat or Telegram handoff, are Codex settings and never part of the pasted task instruction.

A shared file cannot transfer another person's authority. The operator who creates the scheduled task supplies any non-read-only authorization from their own local session, and the configured lines record both the effect and reviewer identity for later runs. An identity mismatch downgrades the run to read-only; repository access alone does not grant write authority.

The automation derives the current reviewer identity and current repository state at runtime. Private-security work is admitted only when the reviewer already has authorized access and the task explicitly includes that venue.

This complete executor deliberately combines queue coordination with per-candidate review for contributors who choose to operate their own #398 queue. The harness-neutral contract, coordinator responsibilities, and runtime publication mechanics remain separately identifiable so they can be split into thinner adapters without making this full executor mandatory for every reviewer.

Run the prompt-contract checks from the repository root:

```bash
python3 -m unittest discover tools/agent-review-contract/tests -v
```

## Adapt the portable prompt

Replace the configuration block at the top of [`prompts/portable-review-contract.md`](./prompts/portable-review-contract.md). Most projects need only these bindings:

- canonical repository and integration branch;
- coordination surface and review stages;
- terminal stage and the live evidence required to prove it;
- a nonempty monitoring scope used only for global completion evidence;
- task ledger, when the project has one;
- restricted-review venue, when the project has one;
- project review policy and completion action; and
- authenticated reviewer identity and authorized effect.

Keep runtime mechanics in an adapter. The contract should continue to define outcomes, authority, evidence, repairs, and stopping conditions rather than a vendor's tool names.

Every disposition records a canonical assessment-input fingerprint covering reviewer and authority, addressed condition and scope, governing revisions, candidate and integration base, effective effect, and required-oracle/check and clearing-evidence state. Trigger, stage, owner, publication, coordination-write, and readback results are excluded because the disposition itself can change them; an admission fingerprint adds trigger, stage, and owner for the immediate pre-submit drift check. A submitted disposition remains reusable only while its assessment fingerprint is current and its effects are reconciled separately. Scheduled read-only or draft execution keys durable runtime-local hold state by the assessment fingerprint plus current admission and hold state. Reliable read-only execution may update only bounded runtime-local lock, cursor, and hold state, never provider or project state. Missing or unknown provider writes enter reconciliation-only handling and are never retried blindly; an unauthorized missing write is held for the required authorization or human update rather than treated as executable.

## Verification status and limitations

The DACS Codex automation is derived from an executor used for live exact-head DACS reviews, but this public package is a new snapshot. Its initial evidence is structural review, source mapping, secret/private-context scanning, link checking, and prompt-contract checks. The fixed-point rules address an observed executor failure mode in which a completed subset was mistaken for the overall queue result. Behavioral evaluation cases, repeated trials, and the proposed 16-run calibration remain follow-up work under [DACS-Standard discussion #400](https://github.com/DACS-Agent-commerce/DACS-Standard/discussions/400).

Runtime support is claimed one adapter at a time. The included Codex adapter documents configuration only; it does not imply that every Codex permission profile, GitHub account, or installed skill can execute every review lane. Other runtime adapters should be added after they pass the same public fixtures.

## License

MIT, as part of the DACS Community repository.
