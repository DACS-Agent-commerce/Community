# How do agent payment protocols compare?

This page compares only the seven payment rails that the pinned Standard defines. It does not cover other protocols and makes no market, price or ranking claim. Every rail produces the same kind of settlement evidence, but they differ in how a payment settles, when it counts as done and what the evidence cites. Rails also differ in maturity, so a buyer checks each rail's `availability` and does not assume one ([DACS-4, section 9.4.2](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#942-v01-registry-contents)).

## The general idea

To compare ways to pay, ask three things of each:

- what it is: which network, which asset and which handler moves the money;
- how it settles: what has to happen before the payment counts as done;
- what evidence it leaves: what a third party can look up afterwards.

A rail that settles later or in more steps is not better or worse for that reason. It gives a different answer to each question.

## How DACS does it

Every rail has a payment step that returns `ok: true` only when the payment is confirmed under that rail's own finality rules, and anchors settlement evidence that records the finality model applied ([DACS-4, section 9.5.1, rules PC-2, PC-4 and PC-6](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#951-common-contract)). The rails differ as follows:

| Rail step | What it is and how it settles | Evidence it cites |
| --- | --- | --- |
| [`pay-evm-erc20`](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#952-pay-evm-erc20) | A token transfer on one EVM chain. It counts after the number of blocks the rail sets. | `evm-event`: the transaction and the exact transfer log |
| [`pay-solana-spl`](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#953-pay-solana-spl) | A token transfer on one cluster of the network the rail names. It counts at the commitment level the rail sets. | `solana-instruction`: the signature and the exact instruction |
| [`pay-cross-chain-htlc`](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#954-pay-cross-chain-htlc) | A swap across two chains with hash-time-locked contracts. It succeeds only when the payee's claim on the source chain is final. The payer can decline to reveal the secret, and the Standard does not define a way to prevent that. | `htlc-lock`, `htlc-reveal` and `htlc-claim` |
| [`pay-cross-chain-liquidity-tank`](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#955-pay-cross-chain-liquidity-tank) | A cross-chain payment run through the substrate's own bridge. For v0.1 the Standard supports one testnet route. | `liquidity-tank`: the bridge id and both the lock and release hashes |
| [`pay-ap2`](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#956-pay-ap2) | A mandate submitted to a payment provider, settled off-chain. It records that the provider captured the funds, not that they cannot be reversed. For v0.1 the Standard calls it specified but not yet backed by a reference implementation. | `ap2`: the mandate id, the provider reference and an attested receipt |
| [`pay-x402`](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#957-pay-x402) | A payment made to an HTTP resource that answers with a payment request, settled on a chain. | `x402-event`: the settlement transaction, chain, log index and a hash of the receipt |
| [`pay-dem`](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#959-pay-dem) | A native-token transfer to a single payee on the Demos network. A transaction that reaches `included` is final. | `demos`: the transaction hash and block number |

Two further points apply to the table:

- **An open state is not a pass.** If one leg of a cross-chain payment has settled and the other has not, the session is held in a non-terminal state and the evidence records a failure until the other leg resolves. If the window for resolving it expires, the session ends in a failed state ([DACS-4, section 9.5.4](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#954-pay-cross-chain-htlc) and [section 9.5.5](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#955-pay-cross-chain-liquidity-tank)).
- **Evidence ties a payment to one deal.** A consumer that aggregates evidence across sessions does not count one settlement under more than one deal. Some rails also carry a deal reference in the payment itself, and a rail without one is weaker against a transaction cited by coincidence ([DACS-4, section 9.5.8](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#958-session-bound-settlement-evidence-sb-1sb-3)).

In this repository, the [how it works page](../../reference-implementations/dacs-directory/app/how-it-works/page.tsx) lists the rails the pinned SDK integrates: native DEM on the Demos testnet, x402 and EVM ERC-20. All use is on the testnet ([AGENTS.md](../../AGENTS.md)), and the Directory shows signed rail terms and does not move funds.

## Where this is defined

- Rail registry and maturity: [DACS-4, section 9.4](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#94-payment-rail-registry).
- Each rail step: [DACS-4, section 9.5](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#95-payment-phases).
- Settlement evidence: [DACS-4, section 9.7](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#97-settlement-evidence).

Previous: [What is an agent-readable directory?](./what-is-an-agent-readable-directory.md)
Next: [What does an agent agree to before paying?](./what-does-an-agent-agree-to-before-paying.md)
