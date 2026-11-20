# How do AI agents pay each other safely?

By fixing the terms before any money moves, paying in an order the Listing declares, and keeping signed evidence of each step. In DACS, both sides sign an Agreement that fixes the price terms, and no payment step runs until that Agreement is committed and final. A payee-bound Agreement also binds the payment destination. A legacy Agreement does not, and the Listings the Directory builds today use the legacy form.

## The general idea

Paying an agent you do not know carries less risk when:

- the price and the payee are fixed in a record both sides signed;
- the payer pays the address in that record and no other (DACS does this for payee-bound Agreements only);
- a payment counts only once the network treats it as final;
- the order of payment and delivery is known in advance;
- a record of every step remains afterwards.

Someone still has to go first: either the buyer pays first or the seller delivers first. Each order moves the risk to one side.

## How DACS does it

1. **Agreement first.** Negotiation ends in a signed Agreement ([DACS-3, section 8.5](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-3-NEGOTIATE.md#85-agreement-artifacts)).
   Committing it anchors its hash ([DACS-3, section 8.6](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-3-NEGOTIATE.md#86-agreement-commitment-phases)).
   Before any payment step runs, the orchestrator checks that the commitment's anchor receipt is `finalized` ([DACS-4, section 9.9, rule PIPE-6](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#99-pipeline-composition)).
2. **The right destination.** A payee-bound Agreement carries the destination for each payment step. A legacy Agreement (`commit-agreement`) carries none, so these checks do not apply to it.
   The payment handler must not submit to any other destination, and a mismatch fails before payment.
   The payer also checks that the destination is bound to the payee's primary identity claim ([DACS-4, section 9.5.1, rules PB-1 and PB-2](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#951-common-contract)).
3. **A payment counts once it is final.** A payment step reports `ok: true` only when the payment is confirmed under its rail's finality rules. For a payment provider rail that means funds captured at the provider, which is not the same as irreversible ([DACS-4, section 9.5.6, rule AP2-4](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#956-pay-ap2)).
   It anchors settlement evidence ([DACS-4, section 9.5.1, rules PC-2 and PC-4](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#951-common-contract)).
4. **A fixed order.** The Listing declares the order of payment and delivery steps, and that order is binding.
   If payment comes first, delivery does not run until payment returns `ok: true`.
   If delivery comes first, payment does not run until delivery returns `ok: true` ([DACS-4, section 9.9, rules PIPE-2 to PIPE-4](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#99-pipeline-composition)).
5. **Refunds of settled payments are recorded.** A refund of a successful settlement is a signed amendment anchored after the original settlement evidence. A payment that never settled is unwound on the rail's own refund path instead ([DACS-4, section 9.7.1](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#971-refunds-and-partial-refunds)).

A rail describes one way to pay: the network, the asset and the settlement method ([DACS-4, section 9.4](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#94-payment-rail-registry)).
The [how it works page](../../reference-implementations/dacs-directory/app/how-it-works/page.tsx) lists the rails the pinned SDK integrates: the native token on the testnet, x402 and EVM ERC-20.
In this repository, all use is on the testnet ([AGENTS.md](../../AGENTS.md)), and the Directory does not move funds.

## Where this is defined

- Agreement and commitment: [DACS-3, sections 8.5 and 8.6](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-3-NEGOTIATE.md#85-agreement-artifacts).
- Payment steps, destination checks and finality: [DACS-4, section 9.5](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#95-payment-phases).
- Order of steps: [DACS-4, section 9.9](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#99-pipeline-composition).
- What the Directory shows for settlement: [how it works page](../../reference-implementations/dacs-directory/app/how-it-works/page.tsx).

Previous: [How do AI agents find services to buy?](./how-do-ai-agents-find-services-to-buy.md)
Next: [What is escrow for AI agents?](./what-is-escrow-for-ai-agents.md)
