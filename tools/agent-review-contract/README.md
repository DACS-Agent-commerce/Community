# Agent Review Contract

Agent Review Contract is a pair of reusable prompts for evidence-bound pull-request review. The DACS prompt is ready for reviewers working from the public DACS coordinator queue. The portable prompt keeps the same review semantics and exposes the small set of project and runtime bindings another agent environment must supply.

## DACS surface

This tool supports the contributor-review workflow around [DACS-Standard](https://github.com/DACS-Agent-commerce/DACS-Standard), including the public [coordinator review queue](https://github.com/DACS-Agent-commerce/DACS-Standard/issues/398). It does not implement a DACS protocol module or change conformance semantics.

## Conformance status

`prototype`: these prompts support contributor review and evaluation. They have not been promoted into DACS conformance vectors and do not certify a reviewer, model, runtime, pull request, or implementation.

## Choose a prompt

- [`prompts/dacs-review-executor.md`](./prompts/dacs-review-executor.md) is the near-drop-in DACS version. Use it when reviewing DACS-Standard changes coordinated through issue #398.
- [`prompts/portable-review-contract.md`](./prompts/portable-review-contract.md) is the project-neutral template. Replace its configuration values, then use it in any agent environment with repository read access and an authorized review-submission path.
- [`adapters/codex.md`](./adapters/codex.md) maps either prompt onto Codex projects, tasks, and scheduled tasks.
- [`SOURCE_MAPPING.md`](./SOURCE_MAPPING.md) records every material change from the source DACS automation and why it was necessary for public reuse.

Both prompts preserve the same core rule: a requested change includes the exact candidate and location, violated requirement, supporting evidence, compatible repair, expected post-fix behavior, and executable acceptance checks. A reviewer that identifies a defect and leaves the author to rediscover the repair has not completed the review contract.

They also require fixed-point execution: identify every change currently directed to the authenticated reviewer, classify its stage and review readiness, process a safe batch, refresh the complete inventory, and continue until `ACTIONABLE = 0`. A clean individual review or completed batch is not overall completion.

The review-quality rules adopt the public guidance proposed in discussion #400: score the complete disposition rather than approval rate, reject unsupported findings, require exact-candidate pins and runnable repairs, hold when a deciding oracle is missing, stop duplicate reviews on unchanged candidates, handle dirty or stacked candidates without imaginary integration, and separate review completion from merge or release. Restricted findings stay in their authorized venue.

## Use the DACS prompt

1. Open a task in a checkout whose canonical remote is `DACS-Agent-commerce/DACS-Standard`.
2. Authenticate the reviewer through the runtime's normal GitHub integration.
3. Give the runtime the full contents of [`prompts/dacs-review-executor.md`](./prompts/dacs-review-executor.md).
4. Explicitly state the allowed effect, such as read-only assessment, draft review text, or review submission. Access to a repository or private venue does not grant permission to write to it.

The prompt derives the current reviewer identity and current repository state at runtime. Private-security work is admitted only when the reviewer already has authorized access and the task explicitly includes that venue.

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

The DACS prompt is derived from an executor used for live exact-head DACS reviews, but this public package is a new snapshot. Its initial evidence is structural review, source mapping, secret/private-context scanning, link checking, and prompt-contract checks. The fixed-point rules address an observed executor failure mode in which a completed subset was mistaken for the overall queue result. Behavioral evaluation cases, repeated trials, and the proposed 16-run calibration remain follow-up work under [DACS-Standard discussion #400](https://github.com/DACS-Agent-commerce/DACS-Standard/discussions/400).

Runtime support is claimed one adapter at a time. The included Codex adapter documents configuration only; it does not imply that every Codex permission profile, GitHub account, or installed skill can execute every review lane. Other runtime adapters should be added after they pass the same public fixtures.

## License

MIT, as part of the DACS Community repository.
