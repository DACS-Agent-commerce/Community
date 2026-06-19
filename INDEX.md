# Submissions Index

The catalogue of community projects, in-tree and external. Conformance status values are defined in [CONTRIBUTING.md](./CONTRIBUTING.md#submission-requirements): `vector-tested` / `exercises-spec` / `prototype`. **Canonical** marks projects the steward has designated the reference for their niche.

## Reference implementations & apps

| Project | Maintainer | DACS surface | Conformance | License | Status |
|---|---|---|---|---|---|
| agent-commerce-demo | KyneSys Labs | Full lifecycle (DACS-1..5); exercises `pay-x402` end-to-end (buyer-side EIP-3009/Permit2, USDC on Base) | `vector-tested` (golden vectors, DACS-Standard `conformance/`) | TBD on publication | **Canonical** (steward reference implementation; repo currently private, publication pending) |
| [pathos-dacs-ref](https://github.com/cX3po/pathos-dacs-ref) | PATH-OS Labs | DACS-5 §10.4 AttestationBundle + JCS canonical form §B.2 (signed-scope hashing); §10.4.2/3 two-sided anchoring + divergence; DACS-1 identity verify, DACS-2 recipe vetting, DACS-3 sealed-bid, DACS-4 settlement-evidence; selective-disclosure / consent / dispute-evidence layer | `vector-tested` — reproduces the DACS-Standard `conformance/` golden AttestationBundle hashes (§10.4 signed scope + canonical form §B.2); `exercises-spec` for the rest (two-sided anchoring, DACS-1/2/3/4, disclosure/consent/dispute) | MIT | External |

## Tools

| Project | Maintainer | DACS surface | Conformance | License | Status |
|---|---|---|---|---|---|
| [dacs-spec-mcp](./tools/dacs-spec-mcp) | norgejbb-byte | Spec-reference MCP server (read/search/fetch only): §-sections, rule families, artifact schemas, the §14 conformance plan + vectors — served verbatim with `(file, line)` provenance from a pinned DACS-Standard checkout | n/a — reference tool; serves spec text verbatim (byte-equal self-test), not a conformance implementation | MIT | In-tree |
| [dacs-drift](https://github.com/cX3po/pathos-dacs-ref/blob/main/dacs-drift.mts) | PATH-OS Labs | Conformance/drift checker for DACS-5 §10.4 AttestationBundle signed-scope hashes (v0.1 R5-1 anchoredByRole-excluded form), against an expected-hash manifest or the DACS-Standard golden hashes. Point it at an implementation's bundle fixtures; reports conform/drift for the §10.4 hash surface | `vector-tested` — reproduces the DACS-Standard golden bundle hashes; checks §10.4 AttestationBundle hash conformance | MIT | External |

## Integrations

| Project | Maintainer | DACS surface | Conformance | License | Status |
|---|---|---|---|---|---|
| — | | | | | |

## Examples

| Project | Maintainer | DACS surface | Conformance | License | Status |
|---|---|---|---|---|---|
| — | | | | | |
