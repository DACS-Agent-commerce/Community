# Contributing to DACS Community

Implementation work is the most valuable contribution to a young standard. This repo exists to make submitting it cheap.

## Two ways to submit

**In-tree** — small, self-contained projects (a validator script, a bundle inspector, a worked example). Your code is vendored into the appropriate directory and licensed MIT with the repo.

**External** — anything with its own life (an SDK, a full reference implementation, a rail adapter you maintain). Your project stays in your repo under any OSI-approved license; you submit an entry to [INDEX.md](./INDEX.md).

Both are a single PR.

## Submission requirements

Every submission — in-tree or external — declares, in its README (in-tree) or INDEX entry (external):

1. **What it is** — one paragraph, plain language.
2. **DACS surface** — which modules and sections it implements or touches (e.g. "DACS-4 §9.5.7 `pay-x402` phase handler", "DACS-2 `zktls` method provider").
3. **Conformance status, stated honestly** — one of:
   - `vector-tested` — passes named [conformance vectors](https://github.com/DACS-Agent-commerce/DACS-Standard/tree/main/conformance); say which.
   - `exercises-spec` — implements against the spec but not vector-verified.
   - `prototype` — exploratory; may diverge from the spec.

   Overstated conformance claims are the one thing that gets a submission removed. The standard's own culture is honest maturity disclosure (see the spec's rail reference-backing notes); the same bar applies here.
4. **How to run it** — build/run instructions that work from a fresh clone.
5. **License** — MIT-compatible for in-tree; any OSI-approved license for external.
6. **No secrets** — no API keys, no private endpoints, no mnemonic phrases beyond the published Demos test mnemonic.

## Review

The steward (or a maintainer) reviews for **fit and honesty of claims** — is it DACS-related, is it placed correctly, does the conformance declaration match reality. Review is **not** a security audit, and inclusion is **not** an endorsement. Consumers run community code at their own risk.

## Canonical designation

Per the standard's [ROADMAP, Part 2](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/main/ROADMAP.md) model — *contributor prototypes, steward owns the standard* — the steward may designate a community project **canonical** for its niche once it has proven solid (typically: `vector-tested`, maintained, exercised in real sessions). Canonical status is recorded in the INDEX and revocable if the project goes stale.

## Keeping entries current

- Bump your INDEX entry when your project's DACS surface or conformance status changes — especially across spec minor versions (the spec's CHANGELOG lists every normative change with section numbers, so you can scan what affects you).
- Entries pointing at archived/404 repos are pruned in periodic sweeps.

## Spec feedback

Building against DACS is exactly how spec defects get found. When you hit one, file it on [DACS-Standard](https://github.com/DACS-Agent-commerce/DACS-Standard/issues) — section number, artifact, proposed fix — not here. Issues here are for the community projects themselves.
