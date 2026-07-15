# Submissions Index

The catalogue of community projects, in-tree and external. Conformance status values are defined in [CONTRIBUTING.md](./CONTRIBUTING.md#submission-requirements): `vector-tested` / `exercises-spec` / `prototype`. **Canonical** marks projects the steward has designated the reference for their niche.

## Reference implementations & apps

| Project | Maintainer | DACS surface | Conformance | License | Status |
|---|---|---|---|---|---|
| agent-commerce-demo | KyneSys Labs | Full lifecycle (DACS-1..5); exercises `pay-x402` end-to-end (buyer-side EIP-3009/Permit2, USDC on Base) | `vector-tested` (golden vectors, DACS-Standard `conformance/`) | TBD on publication | **Canonical** (steward reference implementation; repo currently private, publication pending) |
| [dacs-directory](./reference-implementations/dacs-directory) | [randomblocker](https://github.com/randomblocker) | Community agent catalog and browser UI: DACS-1 §6.3.6 catalog API and ListingSummary/ReputationHint shapes; DACS-1 CCI identity resolution; DACS-5 §10.4 bundle and referenced-artifact verification; §10.5 reputation derivation | `exercises-spec` — implementation tests cover security boundaries and verification policy; no claim of full golden-vector coverage | MIT | In-tree |
| [pathos-dacs-ref](https://github.com/cX3po/pathos-dacs-ref) | PATH-OS Labs | DACS-5 §10.4 AttestationBundle + JCS canonical form §B.2 (signed-scope hashing); §10.4.2/3 two-sided anchoring + divergence; DACS-1 identity verify, DACS-2 recipe vetting, DACS-3 sealed-bid, DACS-4 settlement-evidence; selective-disclosure / consent / dispute-evidence layer | `vector-tested` — reproduces the DACS-Standard `conformance/` golden AttestationBundle hashes (§10.4 signed scope + canonical form §B.2); `exercises-spec` for the rest (two-sided anchoring, DACS-1/2/3/4, disclosure/consent/dispute) | MIT | External |
| [dacs-verify](https://github.com/mj-deving/dacs-verify) | mj-deving | Independent Bun/TypeScript verifier and conformance runner for DACS v0.1: canonical JSON + content hashes (§B.2), domain-separated signatures (§B.7), DACS-1 identity/listing checks, DACS-2 vetting primitives, DACS-3 agreement checks, DACS-4 settlement evidence, DACS-5 AttestationBundle/reputation verification, plus a proposed DACS-X dispute/disclosure prototype. **Generates DACS-Standard's published §14 golden vectors** — named as the `generator` in `conformance/MANIFEST.json` | `vector-tested` — passes 186 DACS-Standard golden conformance checks across DACS-1..5 verifier surfaces; DACS-X dispute/disclosure code is `prototype` / non-normative | MIT | External |
| [stranger-gauntlet](https://github.com/cX3po/pathos-dacs-ref/tree/main/showcase/stranger-gauntlet) | PATH-OS Labs | A2A trust showcase — one Shopper vets three stranger vendor agents through the DACS-5 §10.4.1 AttestationBundle acceptance verifier: two honest bundles → `accept`; a bundle tampered *after* signing → `reject` with the decisive check named. Exercises §10.4.1 signed-scope hashing (R5-1 anchoredByRole-excluded canonical form) and §7.5.1 do-not-collapse (`accept` vs `reject`/`indeterminate`) | `exercises-spec` — demonstrates the §10.4.1 verifier catching a counterfeit built from local fixed-seed fixtures (not named DACS-Standard vectors); the underlying verifier + canonical hasher are the vector-tested pathos-dacs-ref. Deterministic, zero-network, no deployed identities | MIT | External |
| [verify-peer](https://github.com/cX3po/pathos-dacs-ref/tree/main/showcase/verify-peer) | PATH-OS Labs | A2A peer-trust gate — `verifyPeer()` + the `withDacsTrust()` middleware bind an A2A AgentCard's *claimed* identity to the identity a DACS-5 §10.4.1 AttestationBundle *cryptographically proves* signed it; an impostor whose card claims identity X but whose bundle proves identity Y is declined (`identity-mismatch`), handler never runs. Exercises §10.4.1 acceptance verification and §7.5.1 do-not-collapse (unresolvable/ambiguous → `indeterminate`, never a borrowed `pass`) | `exercises-spec` — card↔bundle identity binding over the vector-tested §10.4.1 verifier, using local fixed-seed fixtures (not a named-vector run). Deterministic, zero-network | MIT | External |

## Tools

| Project | Maintainer | DACS surface | Conformance | License | Status |
|---|---|---|---|---|---|
| [dacs-spec-mcp](./tools/dacs-spec-mcp) | norgejbb-byte | Spec-reference MCP server (read/search/fetch only): §-sections, rule families, artifact schemas, the §14 conformance plan + vectors — served verbatim with `(file, line)` provenance from a pinned DACS-Standard checkout | n/a — reference tool; serves spec text verbatim (byte-equal self-test), not a conformance implementation | MIT | In-tree |
| [dacs-drift](https://github.com/cX3po/pathos-dacs-ref/blob/main/dacs-drift.mts) | PATH-OS Labs | Conformance/drift checker for DACS-5 §10.4 AttestationBundle signed-scope hashes (v0.1 R5-1 anchoredByRole-excluded form), against an expected-hash manifest or the DACS-Standard golden hashes. Point it at an implementation's bundle fixtures; reports conform/drift for the §10.4 hash surface | `vector-tested` — reproduces the DACS-Standard golden bundle hashes; checks §10.4 AttestationBundle hash conformance | MIT | External |
| [convergence-harness](https://github.com/cX3po/pathos-dacs-ref/tree/main/conformance/security-vectors/convergence-harness) | PATH-OS Labs | Cross-impl convergence harness for the DACS-5 §10.4 AttestationBundle surface: independent implementations each compute the §10.4.1/R5-1 canonical signed-scope hash `sha256(JCS(bundle − signatures − anchoredByRole))` over a shared corpus and are compared (PRIMARY = key-free canonical-hash convergence; SECONDARY = §7.5.1 decision agreement on portable-resolvable bundles). Ships an independent 2nd adapter over [dacs-verify](https://github.com/mj-deving/dacs-verify) (mj-deving) — vendored verbatim (commit `10aefa7f`, MIT, attributed in `SOURCE.md`) — giving a genuine 2-impl matrix (pathos-dacs-ref ↔ dacs-verify): canonical-hash convergence 3/3, no decision divergence | `exercises-spec` — measures convergence over its own in-repo §10.4 corpus (not named DACS-Standard vectors); the two impls reproduce byte-identical canonical hashes on all 3 bundles. Reports convergence evidence, does not certify conformance — the steward owns what "DACS-conformant" normatively means | MIT | External |

## Integrations

| Project | Maintainer | DACS surface | Conformance | License | Status |
|---|---|---|---|---|---|
| — | | | | | |

## Examples

| Project | Maintainer | DACS surface | Conformance | License | Status |
|---|---|---|---|---|---|
| — | | | | | |
