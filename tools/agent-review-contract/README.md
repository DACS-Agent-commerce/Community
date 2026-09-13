# Agent Review Contract

Agent Review Contract is a pair of reusable prompts for evidence-bound pull-request review. The DACS Codex automation is the drop-in task instruction for reviewers working from the public DACS coordinator queue. The portable prompt keeps the same review semantics and exposes the small set of project and runtime bindings another agent environment must supply.

## DACS surface

This tool supports the contributor-review workflow around [DACS-Standard](https://github.com/DACS-Agent-commerce/DACS-Standard), including the public [coordinator review queue](https://github.com/DACS-Agent-commerce/DACS-Standard/issues/398). It does not implement a DACS protocol module or change conformance semantics.

## Conformance status

`prototype`: these prompts support contributor review and evaluation. They have not been promoted into DACS conformance vectors and do not certify a reviewer, model, runtime, pull request, or implementation.

## Choose a prompt

- [`prompts/dacs-codex-automation.md`](./prompts/dacs-codex-automation.md) is the complete Codex task instruction for DACS-Standard review automation. Its safe copy-paste default is read-only.
- [`prompts/portable-review-contract.md`](./prompts/portable-review-contract.md) is the project-neutral template. Replace its configuration values, then use it in any agent environment with repository read access and an authorized review-submission path.
- [`adapters/codex.md`](./adapters/codex.md) maps either prompt onto Codex projects, tasks, and scheduled tasks.
- [`SOURCE_MAPPING.md`](./SOURCE_MAPPING.md) records every material change from the source DACS automation and why it was necessary for public reuse.

Both prompts preserve the same core rule: a requested change includes the exact candidate and location, violated requirement, supporting evidence, compatible repair, expected post-fix behavior, and executable acceptance checks. A reviewer that identifies a defect and leaves the author to rediscover the repair has not completed the review contract.

They also require fixed-point execution: identify every change currently directed to the authenticated reviewer, classify its stage and review readiness, process a safe batch, refresh the complete inventory, and continue until `ACTIONABLE = 0`. Overall completion additionally requires `HOLD = 0`; a clean individual review or completed batch is not enough.

The review-quality rules adopt the public guidance proposed in discussion #400: score the complete disposition rather than approval rate, reject unsupported findings, require exact-candidate pins and runnable repairs, hold when a deciding oracle is missing, stop duplicate reviews on unchanged candidates, handle dirty or stacked candidates without imaginary integration, and separate review completion from merge or release. Restricted findings stay in their authorized venue.

## Copy the DACS Codex automation

The automation text is the full content of [`prompts/dacs-codex-automation.md`](./prompts/dacs-codex-automation.md). The file contains the complete review contract and one operator setting, `AUTHORIZED_EFFECT`. The README and Codex adapter are setup documentation and are not part of the scheduled task instruction.

1. Select a local Codex project whose canonical remote is `DACS-Agent-commerce/DACS-Standard`.
2. Keep `AUTHORIZED_EFFECT: READ_ONLY`, or directly authorize Codex in the local creation instruction to replace it with exactly one other allowed value: `DRAFT_ONLY` or `SUBMIT_REVIEWS_AND_PUBLIC_SAFE_398_UPDATES`.
3. Paste the configured complete automation file into the scheduled task's instruction field.
4. Choose the schedule, model, and notification policy in Codex. Delivery or notification steps, for example a chat or Telegram handoff, are Codex settings and never part of the pasted task instruction.

A shared file cannot transfer another person's authority. The operator who creates the scheduled task supplies any non-read-only authorization from their own local session, and the configured line records that binding for later runs. Repository access alone does not grant write authority.

The automation derives the current reviewer identity and current repository state at runtime. Private-security work is admitted only when the reviewer already has authorized access and the task explicitly includes that venue.

Run the prompt-contract checks from the repository root:

```bash
python3 -m unittest discover tools/agent-review-contract/tests -v
```

## Adapt the portable prompt

Replace the configuration block at the top of [`prompts/portable-review-contract.md`](./prompts/portable-review-contract.md). Most projects need only these bindings:

- canonical repository and integration branch;
- coordination surface and review stages;
- task ledger, when the project has one;
- restricted-review venue, when the project has one;
- project review policy and completion action.

Keep runtime mechanics in an adapter. The contract should continue to define outcomes, authority, evidence, repairs, and stopping conditions rather than a vendor's tool names.

## Verification status and limitations

The DACS Codex automation is derived from an executor used for live exact-head DACS reviews, but this public package is a new snapshot. Its initial evidence is structural review, source mapping, secret/private-context scanning, link checking, and prompt-contract checks. The fixed-point rules address an observed executor failure mode in which a completed subset was mistaken for the overall queue result. Behavioral evaluation cases, repeated trials, and the proposed 16-run calibration remain follow-up work under [DACS-Standard discussion #400](https://github.com/DACS-Agent-commerce/DACS-Standard/discussions/400).

Runtime support is claimed one adapter at a time. The included Codex adapter documents configuration only; it does not imply that every Codex permission profile, GitHub account, or installed skill can execute every review lane. Other runtime adapters should be added after they pass the same public fixtures.

## License

MIT, as part of the DACS Community repository.
