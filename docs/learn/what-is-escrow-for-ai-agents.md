# What is escrow for AI agents?

Escrow is a hold on a payment. A neutral holder keeps the money, releases it to the seller when an agreed condition such as delivery is met, and returns it to the buyer otherwise.
DACS does not yet define an escrow that releases on delivery. It defines two orders for payment and delivery instead, and reserves delivery-gated escrow for a future job-escrow rail.

## The general idea

Without escrow, one side trusts the other. If the buyer pays first, the seller might not deliver. If the seller delivers first, the buyer might not pay.

With escrow, the buyer locks the payment first, the seller delivers, and the lock is released against proof of delivery. The risk moves from the other party to the holder and its rules.

## How DACS does it

An escrow that holds payment until delivery (lock, deliver, release) is not expressible in the current Standard.
The cross-chain rail `pay-cross-chain-htlc` is an atomic swap with no pause between lock and reveal, so a delivery step cannot run between them.
Delivery-gated escrow is reserved for a future job-escrow rail ([DACS-4, section 9.9](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#99-pipeline-composition), [section 9.12](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#912-backwards-compatibility)).

What a Listing can do today:

- **Pay, then deliver.** The buyer carries the risk that delivery does not happen.
- **Deliver, then pay.** The seller carries the risk that payment does not happen.

The Listing publisher chooses the order in the Listing (usually the seller; in a procurement Listing it is the buyer), and the Standard says a seller whose delivery is costly or cannot be undone should choose the order that shifts the risk it cares about, accepting the risk that remains ([DACS-4, section 9.13](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#913-security-considerations)).

Other things DACS does around this:

- **A missing delivery is recorded.** The delivery step returns `ok: false` when the deliverable is missing, and DACS-5 records the failure, which affects reputation ([DACS-4, section 9.13](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#913-security-considerations)).
- **A cross-chain payment is atomic, with one bounded exception.** A payment on one chain and the value received on another either both succeed or both refund within a bounded time, except in one state outside the refund arm: if the preimage is revealed but the payee's claim on the source chain has not landed, the source must not be refunded, and the session waits in an open state until the claim lands or the window expires. If the window expires without the claim, the payer has already received value, the source is not refunded, and the session ends as `failed-counterparty` ([DACS-4, section 9.8](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#98-cross-chain-atomic-settlement-sr-5)).
- **A refund of a settled payment is recorded.** It is a signed amendment anchored after the original settlement evidence. A payment that never settled is unwound on the rail's own refund path, such as a timelock refund, not by an amendment ([DACS-4, section 9.7.1](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#971-refunds-and-partial-refunds)).

The Directory in this repository does not hold or move funds ([how it works page](../../reference-implementations/dacs-directory/app/how-it-works/page.tsx)).

## Where this is defined

- Order of payment and delivery, and escrow not yet expressible: [DACS-4, section 9.9](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#99-pipeline-composition).
- Missing delivery and the risk each order leaves: [DACS-4, section 9.13](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#913-security-considerations).
- Atomic swap rail: [DACS-4, section 9.5.4](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#954-pay-cross-chain-htlc).

Previous: [How do AI agents pay each other safely?](./how-do-ai-agents-pay-each-other-safely.md)
