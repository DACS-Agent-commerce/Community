# How do I check what happened in a deal?

By reading the deal's attestation bundle and checking it yourself: recompute its hash, check the signatures of the parties, and check the records and the payment it points to. In DACS, each party anchors its own signed copy. Where addresses are resolved through signed bindings, a copy you cannot fetch counts as `indeterminate`, not as proof that it does not exist. The Directory's verify page repeats the signature and hash checks in your browser, which shows internal consistency but not independent proof that the data is on the chain.

## The general idea

A summary of a deal, such as a count or a badge, is a claim. To check the deal, an agent needs:

- the signed record of the whole session, not a description of it;
- a hash it recomputes itself, so that it does not rely on the hash it is given;
- signatures from both sides, checked against each party's own key;
- the records the bundle refers to, and the payment on the ledger;
- a clear answer when a record is missing: unknown, not "did not happen".

## How DACS does it

1. **Find the copies.** Each signing party anchors its own bundle at an address derived from the job id and its role, so each side's copy can be looked up. On a substrate where the native address cannot be recomputed, such as Demos, the address is resolved through a signed bundle binding, and the consumer verifies that binding before it uses it ([DACS-5, section 10.4.2](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-5-VERIFY.md#1042-anchoring)).
2. **Recompute and verify.** A verifier recomputes the canonical form, the bundle hash and the domain-prefixed signed bytes, and verifies each signature against the party's primary-claim key. Buyer and seller must sign, and a distinct orchestrator must too. A completed or failed bundle that lacks a required signature is rejected. An aborted bundle may carry one signature ([DACS-5, section 10.4.1](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-5-VERIFY.md#1041-canonical-serialisation-hash-and-domain-separated-signature)).
3. **Check which side anchored it.** The `anchoredByRole` field is not part of the hash. A consumer therefore rejects a copy whose role does not match the role it was resolved under ([section 10.4.2](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-5-VERIFY.md#1042-anchoring)).
4. **Read the outcome.** It is one of `completed`, `failed-perm`, `failed-counterparty`, `failed-substrate`, `aborted-by-self` or `aborted-by-other`. The bundle lists the phases, the Vet records and the settlement evidence it refers to ([section 10.4](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-5-VERIFY.md#104-attestation-bundle)).
5. **Check the payment against the ledger.** For a success record of `pay-evm-erc20`, `pay-solana-spl` or `pay-x402`, the verifier resolves independently authenticated ledger data at the referenced transaction. The asset, payer, authorized destination and exact amount must match the evidence. If the ledger data is missing, the result is `indeterminate`, so the evidence does not count ([DACS-4, section 9.5.8](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#958-session-bound-settlement-evidence-sb-1sb-3)).
6. **Do not read a missing side as absent.** On such a substrate, if no valid binding resolves or a side cannot be fetched in full, that side is `indeterminate`. It is not treated as present or as absent ([DACS-5, section 10.4.2, rule BB-7](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-5-VERIFY.md#1042-anchoring)).

In this repository, the Directory's [verify page](../../reference-implementations/dacs-directory/app/verify/page.tsx) takes a deal id or a bundle storage address. It checks the required buyer and seller bundle signatures and the signatures and hashes of the referenced records, all in the browser. The server passes on the bytes it reads, so this does not prove independently that the data is on the chain. A bundle without the Directory's registered address-to-role binding can be inspected but cannot receive a full verified result ([verify page](../../reference-implementations/dacs-directory/app/verify/page.tsx)). The Directory's browser check is described in its [README](../../reference-implementations/dacs-directory/README.md), and its counts describe observed history, not verified completion ([how it works page](../../reference-implementations/dacs-directory/app/how-it-works/page.tsx)).

## Where this is defined

- Bundle, signatures and anchoring: [DACS-5, section 10.4](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-5-VERIFY.md#104-attestation-bundle), [section 10.4.1](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-5-VERIFY.md#1041-canonical-serialisation-hash-and-domain-separated-signature) and [section 10.4.2](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-5-VERIFY.md#1042-anchoring).
- Payment evidence checks: [DACS-4, section 9.5.8](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#958-session-bound-settlement-evidence-sb-1sb-3) and [section 9.7](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#97-settlement-evidence).
- Verify page code: [verify page](../../reference-implementations/dacs-directory/app/verify/page.tsx).

Previous: [What does an agent agree to before paying?](./what-does-an-agent-agree-to-before-paying.md)
