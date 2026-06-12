# DACS Community

**Community-contributed tools, reference implementations, integrations, and apps built on the [DACS](https://github.com/DACS-Agent-commerce/DACS-Standard) agent-commerce standard.**

[![Standard](https://img.shields.io/badge/standard-DACS%20v0.1-2B36D9)](https://github.com/DACS-Agent-commerce/DACS-Standard)
[![License: MIT](https://img.shields.io/badge/license-MIT-FF4808)](./LICENSE)
[![Status](https://img.shields.io/badge/contents-non--normative-010109)](#relationship-to-the-standard)

DACS specifies the agent commerce lifecycle — `Identify → Vet → Negotiate → Settle → Verify` — as one standard per stage. This repo is where the ecosystem *around* the standard lives: implementations that exercise it, tools that make building against it easier, and integrations that connect it to other stacks.

## Relationship to the standard

Nothing in this repository is normative. The specification, conformance vectors, and CHANGELOG live in [DACS-Standard](https://github.com/DACS-Agent-commerce/DACS-Standard); conformance is defined there and only there.

This repo operates under the model described in the standard's [ROADMAP, Part 2](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/main/ROADMAP.md): **contributor prototypes, steward owns the standard**. Community work is welcomed without ceremony, never changes the spec, and may be **designated canonical by the steward** if it proves solid — at which point it is marked as such in the [INDEX](./INDEX.md).

## What goes where

| Directory | Contents |
|---|---|
| [`reference-implementations/`](./reference-implementations/) | Implementations of one or more DACS stages — full lifecycle, a single phase handler, or an application/product built on the standard |
| [`tools/`](./tools/) | Developer tooling: validators, vector runners, bundle inspectors, codegen, debugging aids |
| [`integrations/`](./integrations/) | Bridges to other stacks: payment-rail adapters (x402, AP2, ERC-20/SPL), identity/vetting method providers, substrate bindings |
| [`examples/`](./examples/) | Worked end-to-end sessions, sample artifacts, tutorial material |

Projects can live **in-tree** (small, self-contained — vendored here under MIT) or **externally** (your own repo, any OSI license, listed in the [INDEX](./INDEX.md)). Both routes go through the same [submission process](./CONTRIBUTING.md).

## Submissions index

The catalogue of all accepted submissions — in-tree and external — is **[INDEX.md](./INDEX.md)**, including each project's DACS surface (which modules/§ it touches) and its self-declared conformance status.

## What does *not* go here

- **Spec defects, proposals, RFCs** → [DACS-Standard issues](https://github.com/DACS-Agent-commerce/DACS-Standard/issues) / [discussions](https://github.com/DACS-Agent-commerce/DACS-Standard/discussions)
- **Conformance vectors** → [DACS-Standard `conformance/`](https://github.com/DACS-Agent-commerce/DACS-Standard/tree/main/conformance) (vectors are normative artifacts)
- **Security reports** → see [SECURITY.md](./SECURITY.md)

## Submitting

See [CONTRIBUTING.md](./CONTRIBUTING.md). The short version: open a PR that adds your project (in-tree) or its INDEX entry (external), with an honest declaration of what it implements and how far its conformance has been verified. Inclusion means curation, not endorsement or audit.

## License

The repository structure and in-tree contributions are [MIT](./LICENSE). Externally-indexed projects carry their own licenses, declared in their INDEX entries.
